import type { WebflowSite, WebflowCollection, WebflowField, WebflowItem } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('webflow');
const API_BASE = 'https://api.webflow.com/v2';

function getToken(): string {
  const rawToken = process.env.WEBFLOW_API_TOKEN;
  if (!rawToken) throw new Error('WEBFLOW_API_TOKEN is not set');

  const token = rawToken.trim().replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('WEBFLOW_API_TOKEN is empty');
  return token;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    'Content-Type': 'application/json',
    'accept-version': '2.0.0',
  };
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET';
  log.debug(`${method} ${path}`);

  const start = Date.now();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers(), ...options?.headers },
  });
  const ms = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    log.warn(`${method} ${path} → ${res.status} (${ms}ms)`, { body });
    throw new Error(`Webflow API error ${res.status}: ${body}`);
  }

  log.debug(`${method} ${path} → ${res.status} (${ms}ms)`);
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

// ─── Sites ──────────────────────────────────────────────────────

export async function listSites(): Promise<WebflowSite[]> {
  const data = await apiRequest<{ sites: { id: string; displayName: string; shortName: string }[] }>('/sites');
  return data.sites.map(s => ({
    id: s.id,
    displayName: s.displayName,
    shortName: s.shortName,
  }));
}

// ─── Collections ────────────────────────────────────────────────

export async function listCollections(siteId: string): Promise<WebflowCollection[]> {
  // The list endpoint returns collection metadata only (no fields).
  // We fetch each collection individually to get its field schemas.
  const data = await apiRequest<{
    collections: {
      id: string;
      displayName: string;
      singularName?: string;
      slug: string;
    }[];
  }>(`/sites/${siteId}/collections`);

  const collections: WebflowCollection[] = [];
  for (const c of data.collections) {
    try {
      const full = await getCollection(c.id);
      collections.push(full);
    } catch {
      // If fetching fields fails, include the collection without fields
      collections.push({
        id: c.id,
        displayName: c.displayName,
        slug: c.slug,
        fields: [],
      });
    }
  }

  return collections;
}

export async function getCollection(collectionId: string): Promise<WebflowCollection> {
  const c = await apiRequest<{
    id: string;
    displayName: string;
    slug: string;
    fields: {
      id: string;
      slug: string;
      displayName: string;
      type: string;
      isRequired: boolean;
      isEditable: boolean;
      validations?: Record<string, unknown>;
    }[];
  }>(`/collections/${collectionId}`);

  return {
    id: c.id,
    displayName: c.displayName,
    slug: c.slug,
    fields: c.fields.map(f => ({
      id: f.id,
      slug: f.slug,
      displayName: f.displayName,
      type: f.type as WebflowField['type'],
      isRequired: f.isRequired,
      isEditable: f.isEditable,
      validations: f.validations,
    })),
  };
}

// ─── Field Creation ─────────────────────────────────────────────

export async function createField(
  collectionId: string,
  field: { displayName: string; type: string; isRequired?: boolean }
): Promise<WebflowField> {
  const f = await apiRequest<{
    id: string;
    slug: string;
    displayName: string;
    type: string;
    isRequired: boolean;
    isEditable: boolean;
    validations?: Record<string, unknown>;
  }>(`/collections/${collectionId}/fields`, {
    method: 'POST',
    body: JSON.stringify({
      displayName: field.displayName,
      type: field.type,
      isRequired: field.isRequired ?? false,
    }),
  });

  return {
    id: f.id,
    slug: f.slug,
    displayName: f.displayName,
    type: f.type as WebflowField['type'],
    isRequired: f.isRequired,
    isEditable: f.isEditable,
    validations: f.validations,
  };
}

// ─── Collection Items ───────────────────────────────────────────

export async function listItems(collectionId: string): Promise<WebflowItem[]> {
  const items: WebflowItem[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await apiRequest<{
      items: {
        id: string;
        fieldData: Record<string, unknown>;
        isDraft: boolean;
        isArchived: boolean;
        createdOn: string;
        lastPublished?: string;
        lastUpdated: string;
      }[];
      pagination: { total: number; offset: number; limit: number };
    }>(`/collections/${collectionId}/items?offset=${offset}&limit=${limit}`);

    for (const item of data.items) {
      items.push({
        id: item.id,
        fieldData: item.fieldData,
        isDraft: item.isDraft,
        isArchived: item.isArchived,
        createdOn: item.createdOn,
        lastPublished: item.lastPublished,
        lastUpdated: item.lastUpdated,
      });
    }

    if (items.length >= data.pagination.total) break;
    offset += limit;
  }

  log.debug(`listItems fetched ${items.length} items total`, { collectionId });
  return items;
}

export async function getItem(collectionId: string, itemId: string): Promise<WebflowItem> {
  const item = await apiRequest<{
    id: string;
    fieldData: Record<string, unknown>;
    isDraft: boolean;
    isArchived: boolean;
    createdOn: string;
    lastPublished?: string;
    lastUpdated: string;
  }>(`/collections/${collectionId}/items/${itemId}`);

  return {
    id: item.id,
    fieldData: item.fieldData,
    isDraft: item.isDraft,
    isArchived: item.isArchived,
    createdOn: item.createdOn,
    lastPublished: item.lastPublished,
    lastUpdated: item.lastUpdated,
  };
}

export async function createItem(
  collectionId: string,
  fieldData: Record<string, unknown>,
  options?: { isDraft?: boolean; isArchived?: boolean }
): Promise<WebflowItem> {
  const item = await apiRequest<{
    id: string;
    fieldData: Record<string, unknown>;
    isDraft: boolean;
    isArchived: boolean;
    createdOn: string;
    lastPublished?: string;
    lastUpdated: string;
  }>(`/collections/${collectionId}/items`, {
    method: 'POST',
    body: JSON.stringify({
      fieldData,
      isDraft: options?.isDraft ?? false,
      isArchived: options?.isArchived ?? false,
    }),
  });

  return {
    id: item.id,
    fieldData: item.fieldData,
    isDraft: item.isDraft,
    isArchived: item.isArchived,
    createdOn: item.createdOn,
    lastPublished: item.lastPublished,
    lastUpdated: item.lastUpdated,
  };
}

export async function updateItem(
  collectionId: string,
  itemId: string,
  fieldData: Record<string, unknown>,
  options?: { isDraft?: boolean; isArchived?: boolean }
): Promise<WebflowItem> {
  const body: Record<string, unknown> = { fieldData };
  if (options?.isDraft !== undefined) body.isDraft = options.isDraft;
  if (options?.isArchived !== undefined) body.isArchived = options.isArchived;

  const item = await apiRequest<{
    id: string;
    fieldData: Record<string, unknown>;
    isDraft: boolean;
    isArchived: boolean;
    createdOn: string;
    lastPublished?: string;
    lastUpdated: string;
  }>(`/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

  return {
    id: item.id,
    fieldData: item.fieldData,
    isDraft: item.isDraft,
    isArchived: item.isArchived,
    createdOn: item.createdOn,
    lastPublished: item.lastPublished,
    lastUpdated: item.lastUpdated,
  };
}

export async function deleteItem(collectionId: string, itemId: string): Promise<void> {
  await apiRequest(`/collections/${collectionId}/items/${itemId}`, { method: 'DELETE' });
}

// ─── Bulk Operations ────────────────────────────────────────────

export async function createItemsBulk(
  collectionId: string,
  items: { fieldData: Record<string, unknown>; isDraft?: boolean; isArchived?: boolean }[]
): Promise<WebflowItem[]> {
  const results: WebflowItem[] = [];

  // Webflow bulk API supports up to 100 items per request
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const data = await apiRequest<{
      items: {
        id: string;
        fieldData: Record<string, unknown>;
        isDraft: boolean;
        isArchived: boolean;
        createdOn: string;
        lastPublished?: string;
        lastUpdated: string;
      }[];
    }>(`/collections/${collectionId}/items/bulk`, {
      method: 'POST',
      body: JSON.stringify({ items: batch }),
    });

    for (const item of data.items) {
      results.push({
        id: item.id,
        fieldData: item.fieldData,
        isDraft: item.isDraft,
        isArchived: item.isArchived,
        createdOn: item.createdOn,
        lastPublished: item.lastPublished,
        lastUpdated: item.lastUpdated,
      });
    }
  }

  return results;
}

export async function updateItemsBulk(
  collectionId: string,
  items: { id: string; fieldData: Record<string, unknown>; isDraft?: boolean; isArchived?: boolean }[]
): Promise<WebflowItem[]> {
  const results: WebflowItem[] = [];

  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const data = await apiRequest<{
      items: {
        id: string;
        fieldData: Record<string, unknown>;
        isDraft: boolean;
        isArchived: boolean;
        createdOn: string;
        lastPublished?: string;
        lastUpdated: string;
      }[];
    }>(`/collections/${collectionId}/items/bulk`, {
      method: 'PATCH',
      body: JSON.stringify({ items: batch }),
    });

    for (const item of data.items) {
      results.push({
        id: item.id,
        fieldData: item.fieldData,
        isDraft: item.isDraft,
        isArchived: item.isArchived,
        createdOn: item.createdOn,
        lastPublished: item.lastPublished,
        lastUpdated: item.lastUpdated,
      });
    }
  }

  return results;
}

// ─── Publish ────────────────────────────────────────────────────

export async function publishItems(collectionId: string, itemIds: string[]): Promise<void> {
  // Webflow publish supports up to 100 items
  for (let i = 0; i < itemIds.length; i += 100) {
    const batch = itemIds.slice(i, i + 100);
    await apiRequest(`/collections/${collectionId}/items/publish`, {
      method: 'POST',
      body: JSON.stringify({ itemIds: batch }),
    });
  }
}
