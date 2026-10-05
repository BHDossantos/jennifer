-- Bruno's businesses: LearnNoelia and the Esposito Dos Santos Foundation get their own spaces.
ALTER TYPE space ADD VALUE IF NOT EXISTS 'learnnoelia';
ALTER TYPE space ADD VALUE IF NOT EXISTS 'foundation';
