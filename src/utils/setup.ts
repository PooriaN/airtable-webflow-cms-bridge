import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { isProductionLike } from './auth';
import { getDatabaseStatus } from '../config/database';

export const EDITABLE_SETUP_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'AIRTABLE_API_KEY',
  'WEBFLOW_API_TOKEN',
  'APP_PASSWORD',
  'APP_SESSION_SECRET',
  'APP_AUTOMATION_TOKEN',
] as const;

export type EditableSetupKey = typeof EDITABLE_SETUP_KEYS[number];

type SetupFieldMeta = {
  label: string;
  required: boolean;
  category: 'providers' | 'auth' | 'automation';
  kind: 'token' | 'password' | 'secret' | 'connection';
  description: string;
};

const SETUP_FIELD_META: Record<EditableSetupKey, SetupFieldMeta> = {
  DATABASE_URL: {
    label: 'Database URL',
    required: false,
    category: 'providers',
    kind: 'connection',
    description: 'Preferred PostgreSQL connection string. Set this or POSTGRES_URL before using the dashboard.',
  },
  POSTGRES_URL: {
    label: 'Postgres URL',
    required: false,
    category: 'providers',
    kind: 'connection',
    description: 'Alternate PostgreSQL connection string if your platform exposes POSTGRES_URL instead of DATABASE_URL.',
  },
  AIRTABLE_API_KEY: {
    label: 'Airtable API Key',
    required: true,
    category: 'providers',
    kind: 'token',
    description: 'Personal access token used for Airtable discovery and sync operations.',
  },
  WEBFLOW_API_TOKEN: {
    label: 'Webflow API Token',
    required: true,
    category: 'providers',
    kind: 'token',
    description: 'API token used to discover collections and create or update Webflow CMS items.',
  },
  APP_PASSWORD: {
    label: 'Dashboard Password',
    required: true,
    category: 'auth',
    kind: 'password',
    description: 'Shared password used to sign in to the dashboard and protected APIs.',
  },
  APP_SESSION_SECRET: {
    label: 'Session Secret',
    required: true,
    category: 'auth',
    kind: 'secret',
    description: 'Long random secret used to sign the session cookie.',
  },
  APP_AUTOMATION_TOKEN: {
    label: 'Automation Token',
    required: false,
    category: 'automation',
    kind: 'token',
    description: 'Optional token for Airtable automation-triggered sync requests.',
  },
};

export type SetupStatus = {
  productionLike: boolean;
  canSaveFromUi: boolean;
  envFilePath: string;
  databaseConfigured: boolean;
  databaseVariable: 'DATABASE_URL' | 'POSTGRES_URL' | null;
  databaseError: string | null;
  authConfigured: boolean;
  providerCredentialsConfigured: boolean;
  fullyConfigured: boolean;
  fields: Array<SetupFieldMeta & { key: EditableSetupKey; configured: boolean }>;
};

function getEnvFilePath(): string {
  return path.join(process.cwd(), '.env');
}

async function canWriteFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(path.dirname(filePath), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const envFilePath = getEnvFilePath();
  const productionLike = isProductionLike();
  const canSaveFromUi = !productionLike && await canWriteFile(envFilePath);
  const dbStatus = getDatabaseStatus();
  const databaseVariable = hasConfiguredValue(process.env.DATABASE_URL)
    ? 'DATABASE_URL'
    : hasConfiguredValue(process.env.POSTGRES_URL)
      ? 'POSTGRES_URL'
      : null;

  const fields = EDITABLE_SETUP_KEYS.map(key => ({
    key,
    ...SETUP_FIELD_META[key],
    configured: hasConfiguredValue(process.env[key]),
  }));

  const authConfigured = hasConfiguredValue(process.env.APP_PASSWORD) && hasConfiguredValue(process.env.APP_SESSION_SECRET);
  const providerCredentialsConfigured = hasConfiguredValue(process.env.AIRTABLE_API_KEY) && hasConfiguredValue(process.env.WEBFLOW_API_TOKEN);
  return {
    productionLike,
    canSaveFromUi,
    envFilePath,
    databaseConfigured: dbStatus.initialized,
    databaseVariable,
    databaseError: dbStatus.error,
    authConfigured,
    providerCredentialsConfigured,
    fullyConfigured: dbStatus.initialized && authConfigured && providerCredentialsConfigured,
    fields,
  };
}

function serializeEnvValue(value: string): string {
  if (value.length === 0) return '';
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export async function persistSetupValues(values: Partial<Record<EditableSetupKey, string>>): Promise<void> {
  const filePath = getEnvFilePath();
  let content = '# CMS Bridge local configuration\n';

  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('ENOENT')) {
      throw error;
    }
  }

  const lines = content.split(/\r?\n/);
  const updates = new Map<EditableSetupKey, string>();

  for (const key of EDITABLE_SETUP_KEYS) {
    if (key in values && typeof values[key] === 'string') {
      updates.set(key, values[key] as string);
    }
  }

  const seen = new Set<string>();
  const nextLines = lines.map(line => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return line;

    const key = match[1] as EditableSetupKey;
    if (!updates.has(key)) return line;

    seen.add(key);
    return `${key}=${serializeEnvValue(updates.get(key) || '')}`;
  });

  for (const [key, value] of updates.entries()) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${serializeEnvValue(value)}`);
    }

    if (value.length > 0) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  const normalized = `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
  await fs.writeFile(filePath, normalized, 'utf8');
}
