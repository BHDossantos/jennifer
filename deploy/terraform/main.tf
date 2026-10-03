# Jennifer infrastructure per environment (spec §3): one workspace per env
# (staging, production) with separate project/database/credentials.
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
  backend "gcs" {} # bucket/prefix supplied per environment: -backend-config=env/<env>.backend
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "europe-west1" # same region as Bruno AI Workforce; EU data residency
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}
variable "image" { type = string }
variable "rp_id" { type = string }      # passkey relying-party domain, e.g. jennifer.example.com
variable "origins" { type = string }    # comma-separated allowed WebAuthn origins
variable "github_repo" {
  type    = string
  default = "BHDossantos/jennifer"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals { name = "jennifer-${var.environment}" }

resource "google_project_service" "apis" {
  for_each = toset(["run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "cloudkms.googleapis.com", "artifactregistry.googleapis.com", "iamcredentials.googleapis.com"])
  service  = each.value
}

resource "google_service_account" "runtime" {
  account_id   = "${local.name}-run"
  display_name = "Jennifer ${var.environment} runtime"
}

# --- Database: separate instance per environment, private, backed up (RPO 15 min via PITR) ---
resource "google_sql_database_instance" "db" {
  name             = local.name
  database_version = "POSTGRES_16"
  region           = var.region
  deletion_protection = var.environment == "production"
  settings {
    tier              = var.environment == "production" ? "db-custom-1-3840" : "db-f1-micro"
    availability_type = var.environment == "production" ? "REGIONAL" : "ZONAL"
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
    ip_configuration { ipv4_enabled = false
      ssl_mode = "ENCRYPTED_ONLY" }
    database_flags {
      name  = "cloudsql.enable_pgvector"
      value = "on"
    }
  }
}

resource "google_sql_database" "jennifer" {
  name     = "jennifer"
  instance = google_sql_database_instance.db.name
}

# --- Vault master key in KMS; app can encrypt/decrypt data keys only ---
resource "google_kms_key_ring" "ring" {
  name     = local.name
  location = var.region
}

resource "google_kms_crypto_key" "vault" {
  name            = "vault-master"
  key_ring        = google_kms_key_ring.ring.id
  rotation_period = "7776000s" # 90 days
  lifecycle { prevent_destroy = true }
}

resource "google_kms_crypto_key_iam_member" "runtime" {
  crypto_key_id = google_kms_crypto_key.vault.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.runtime.email}"
}

# --- App secrets (values set out of band: gcloud secrets versions add) ---
resource "google_secret_manager_secret" "app" {
  for_each  = toset(["DATABASE_URL", "JENNIFER_API_TOKEN", "JENNIFER_WEBHOOK_SECRET", "OPENAI_API_KEY"])
  secret_id = "${local.name}-${each.value}"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# --- Cloud Run: fast startup, min 1 instance in production so webhooks are never cold-dropped ---
resource "google_cloud_run_v2_service" "api" {
  name     = local.name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = var.environment == "production" ? 1 : 0
      max_instance_count = 3
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.db.connection_name] }
    }
    containers {
      image = var.image
      ports { container_port = 8080 }
      env {
        name  = "JENNIFER_ENV"
        value = var.environment
      }
      env {
        name  = "JENNIFER_RP_ID"
        value = var.rp_id
      }
      env {
        name  = "JENNIFER_ORIGINS"
        value = var.origins
      }
      env {
        name  = "JENNIFER_KMS_KEY"
        value = google_kms_crypto_key.vault.id
      }
      dynamic "env" {
        for_each = google_secret_manager_secret.app
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get { path = "/health" }
      }
    }
  }
}

# --- Keyless CI deploys: GitHub OIDC → Workload Identity Federation (no JSON keys) ---
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name}-gh"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == \"${var.github_repo}\""
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}

resource "google_service_account" "deployer" {
  account_id = "${local.name}-deploy"
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

output "service_url" { value = google_cloud_run_v2_service.api.uri }
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "deployer_email" { value = google_service_account.deployer.email }
