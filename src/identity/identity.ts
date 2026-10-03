import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { Db } from '../db/db.js';
import type { AuditLog } from '../audit/audit.js';

export type Role = 'owner' | 'developer' | 'operator';

export interface Session {
  idHash: string;
  ownerId: string;
  deviceId: string;
  role: Role;
  expiresAt: Date;
  stepUpAt?: Date;
}

export interface IdentityConfig {
  rpId: string; // e.g. jennifer.example.com
  rpName: string;
  origins: string[]; // web origin(s) and the iOS app's associated domain origin
  sessionTtlMs?: number;
  stepUpWindowMs?: number;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Identity (spec §4): passkeys with user verification for sign-in and for
 * step-up on sensitive actions, device-bound sessions, and remote device
 * revocation. Session tokens are random, stored only as hashes, short-lived.
 */
export class IdentityService {
  private challenges = new Map<string, { challenge: string; ownerId: string; kind: 'register' | 'login' | 'step_up'; expires: number; sessionHash?: string }>();
  private readonly sessionTtl: number;
  private readonly stepUpWindow: number;

  constructor(
    private db: Db,
    private clock: Clock,
    private audit: AuditLog,
    private cfg: IdentityConfig,
  ) {
    this.sessionTtl = cfg.sessionTtlMs ?? 12 * 3600_000;
    this.stepUpWindow = cfg.stepUpWindowMs ?? 5 * 60_000;
  }

  // ---- Passkey registration (from an authenticated owner context) --------

  async registrationOptions(ownerId: string, userName: string) {
    const existing = await this.credentials(ownerId);
    const opts = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName,
      userID: new TextEncoder().encode(ownerId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as never })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    const handle = this.remember(opts.challenge, ownerId, 'register');
    return { handle, options: opts };
  }

  async verifyRegistration(handle: string, response: RegistrationResponseJSON, device: { platform: string; osVersion?: string; label?: string }) {
    const ch = this.consume(handle, 'register');
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: this.cfg.origins,
      expectedRPID: this.cfg.rpId,
      requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) throw new JenniferError('identity.registration_failed', 'Passkey registration could not be verified');
    const cred = v.registrationInfo.credential;
    const deviceId = newId('dev');
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO device (id, owner_id, platform, os_version, public_key, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6)', [
        deviceId,
        ch.ownerId,
        device.platform,
        device.osVersion ?? null,
        cred.id,
        this.clock.now(),
      ]);
      await tx.query('INSERT INTO passkey_credential (id, owner_id, public_key, counter, transports, device_id) VALUES ($1,$2,$3,$4,$5,$6)', [
        cred.id,
        ch.ownerId,
        Buffer.from(cred.publicKey),
        cred.counter,
        cred.transports ?? [],
        deviceId,
      ]);
    });
    this.audit.record(ch.ownerId, 'identity.passkey_registered', deviceId, { platform: device.platform });
    return { deviceId, credentialId: cred.id };
  }

  // ---- Sign-in -------------------------------------------------------------

  async loginOptions(ownerId: string) {
    const creds = await this.credentials(ownerId);
    if (creds.length === 0) throw new JenniferError('identity.no_passkey', 'No passkey registered');
    const opts = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })),
      userVerification: 'required',
    });
    return { handle: this.remember(opts.challenge, ownerId, 'login'), options: opts };
  }

  /** Returns a bearer token bound to the passkey's device. */
  async verifyLogin(handle: string, response: AuthenticationResponseJSON): Promise<{ token: string; session: Session }> {
    const ch = this.consume(handle, 'login');
    const { deviceId } = await this.verifyAssertion(ch.ownerId, ch.challenge, response);
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const session: Session = { idHash: hashToken(token), ownerId: ch.ownerId, deviceId, role: 'owner', expiresAt: new Date(now.getTime() + this.sessionTtl), stepUpAt: now };
    await this.db.query('INSERT INTO auth_session (id_hash, owner_id, device_id, role, created_at, expires_at, step_up_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      session.idHash,
      session.ownerId,
      deviceId,
      'owner',
      now,
      session.expiresAt,
      now,
    ]);
    this.audit.record(ch.ownerId, 'identity.login', deviceId, {});
    return { token, session };
  }

  // ---- Step-up for sensitive actions ---------------------------------------

  async stepUpOptions(session: Session) {
    const creds = (await this.credentials(session.ownerId)).filter((c) => c.deviceId === session.deviceId);
    const opts = await generateAuthenticationOptions({ rpID: this.cfg.rpId, allowCredentials: creds.map((c) => ({ id: c.id })), userVerification: 'required' });
    return { handle: this.remember(opts.challenge, session.ownerId, 'step_up', session.idHash), options: opts };
  }

  async verifyStepUp(session: Session, handle: string, response: AuthenticationResponseJSON): Promise<Date> {
    const ch = this.consume(handle, 'step_up');
    if (ch.sessionHash !== session.idHash) throw new JenniferError('identity.challenge_mismatch', 'Step-up challenge belongs to another session');
    const { deviceId } = await this.verifyAssertion(session.ownerId, ch.challenge, response);
    if (deviceId !== session.deviceId) throw new JenniferError('identity.wrong_device', 'Step-up must use the passkey on this device');
    const at = this.clock.now();
    await this.db.query('UPDATE auth_session SET step_up_at = $1 WHERE id_hash = $2', [at, session.idHash]);
    this.audit.record(session.ownerId, 'identity.step_up', deviceId, {});
    return at;
  }

  hasRecentStepUp(session: Session): boolean {
    return !!session.stepUpAt && this.clock.now().getTime() - session.stepUpAt.getTime() <= this.stepUpWindow;
  }

  // ---- Session checks and revocation ---------------------------------------

  async authenticate(token: string): Promise<Session | undefined> {
    const r = await this.db.query<Record<string, any>>(
      `SELECT s.*, d.revoked_at AS device_revoked FROM auth_session s JOIN device d ON d.id = s.device_id WHERE s.id_hash = $1`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row || row.revoked_at || row.device_revoked) return undefined;
    if (new Date(row.expires_at).getTime() <= this.clock.now().getTime()) return undefined;
    return {
      idHash: row.id_hash,
      ownerId: row.owner_id,
      deviceId: row.device_id,
      role: row.role,
      expiresAt: new Date(row.expires_at),
      stepUpAt: row.step_up_at ? new Date(row.step_up_at) : undefined,
    };
  }

  async hasPasskey(ownerId: string): Promise<boolean> {
    return (await this.credentials(ownerId)).length > 0;
  }

  async devices(ownerId: string) {
    return (await this.db.query('SELECT id, platform, os_version, last_seen_at, revoked_at FROM device WHERE owner_id = $1 ORDER BY last_seen_at DESC NULLS LAST', [ownerId])).rows;
  }

  /** Lost phone: revoke the device, its passkeys and every session on it. */
  async revokeDevice(ownerId: string, deviceId: string, actor: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const r = await tx.query('UPDATE device SET revoked_at = $1 WHERE id = $2 AND owner_id = $3 RETURNING id', [now, deviceId, ownerId]);
      if (r.rows.length === 0) throw new JenniferError('identity.device_not_found', 'No such device');
      await tx.query('UPDATE passkey_credential SET revoked_at = $1 WHERE device_id = $2', [now, deviceId]);
      await tx.query('UPDATE auth_session SET revoked_at = $1 WHERE device_id = $2', [now, deviceId]);
    });
    this.audit.record(actor, 'identity.device_revoked', deviceId, {});
  }

  async logout(session: Session): Promise<void> {
    await this.db.query('UPDATE auth_session SET revoked_at = $1 WHERE id_hash = $2', [this.clock.now(), session.idHash]);
  }

  // ---- internals -------------------------------------------------------------

  private async verifyAssertion(ownerId: string, challenge: string, response: AuthenticationResponseJSON): Promise<{ deviceId: string }> {
    const cred = (await this.credentials(ownerId)).find((c) => c.id === response.id);
    if (!cred) throw new JenniferError('identity.unknown_credential', 'Unknown or revoked passkey');
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.cfg.origins,
      expectedRPID: this.cfg.rpId,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.publicKey), counter: cred.counter, transports: cred.transports as never },
      requireUserVerification: true,
    });
    if (!v.verified) throw new JenniferError('identity.assertion_failed', 'Passkey assertion could not be verified');
    // Counter regression suggests a cloned authenticator (synced passkeys report 0).
    if (cred.counter > 0 && v.authenticationInfo.newCounter <= cred.counter) throw new JenniferError('identity.counter_regression', 'Passkey counter did not increase');
    await this.db.query('UPDATE passkey_credential SET counter = $1 WHERE id = $2', [v.authenticationInfo.newCounter, cred.id]);
    await this.db.query('UPDATE device SET last_seen_at = $1 WHERE id = $2', [this.clock.now(), cred.deviceId]);
    return { deviceId: cred.deviceId };
  }

  private async credentials(ownerId: string): Promise<Array<{ id: string; publicKey: Buffer; counter: number; transports: string[]; deviceId: string }>> {
    const r = await this.db.query<Record<string, any>>(
      `SELECT c.* FROM passkey_credential c JOIN device d ON d.id = c.device_id WHERE c.owner_id = $1 AND c.revoked_at IS NULL AND d.revoked_at IS NULL`,
      [ownerId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      publicKey: Buffer.from(x.public_key),
      counter: Number(x.counter),
      transports: typeof x.transports === 'string' ? x.transports.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : (x.transports ?? []),
      deviceId: x.device_id,
    }));
  }

  private remember(challenge: string, ownerId: string, kind: 'register' | 'login' | 'step_up', sessionHash?: string): string {
    const handle = newId('chal');
    this.challenges.set(handle, { challenge, ownerId, kind, sessionHash, expires: this.clock.now().getTime() + 5 * 60_000 });
    return handle;
  }

  /** Challenges are single-use and expire after five minutes. */
  private consume(handle: string, kind: 'register' | 'login' | 'step_up') {
    const ch = this.challenges.get(handle);
    this.challenges.delete(handle);
    if (!ch || ch.kind !== kind || ch.expires < this.clock.now().getTime()) throw new JenniferError('identity.challenge_invalid', 'Challenge expired or already used');
    return ch;
  }
}
