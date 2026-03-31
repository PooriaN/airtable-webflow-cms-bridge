import type { AirtableFieldType, WebflowFieldType, FieldCompatibility, FieldMapping } from '../types';

// ─── Compatibility Matrix: Airtable → Webflow ──────────────────
export const AIRTABLE_TO_WEBFLOW_COMPAT: FieldCompatibility[] = [
  { airtableType: 'singleLineText', webflowTypes: ['PlainText', 'Color'] },
  { airtableType: 'multilineText', webflowTypes: ['RichText', 'PlainText'] },
  { airtableType: 'richText', webflowTypes: ['RichText'] },
  { airtableType: 'multipleAttachments', webflowTypes: ['Image', 'MultiImage', 'File'] },
  { airtableType: 'singleSelect', webflowTypes: ['Option', 'PlainText'] },
  { airtableType: 'number', webflowTypes: ['Number'] },
  { airtableType: 'currency', webflowTypes: ['Number'], notes: 'Currency symbol stripped' },
  { airtableType: 'percent', webflowTypes: ['Number'], notes: '% symbol stripped' },
  { airtableType: 'autoNumber', webflowTypes: ['Number'] },
  { airtableType: 'formula', webflowTypes: ['PlainText', 'Number', 'RichText'], notes: 'Depends on formula output type' },
  { airtableType: 'date', webflowTypes: ['DateTime'] },
  { airtableType: 'dateTime', webflowTypes: ['DateTime'] },
  { airtableType: 'email', webflowTypes: ['Email'] },
  { airtableType: 'phone', webflowTypes: ['Phone'] },
  { airtableType: 'url', webflowTypes: ['Link', 'Video', 'VideoLink'] },
  { airtableType: 'checkbox', webflowTypes: ['Switch'] },
  { airtableType: 'multipleRecordLinks', webflowTypes: ['Reference', 'MultiReference'] },
  { airtableType: 'lookup', webflowTypes: ['PlainText', 'Number'] },
  { airtableType: 'button', webflowTypes: ['Link'] },
  { airtableType: 'rating', webflowTypes: ['Number'] },
  { airtableType: 'count', webflowTypes: ['Number'] },
];

// ─── Compatibility Matrix: Webflow → Airtable ──────────────────
export const WEBFLOW_TO_AIRTABLE_COMPAT: {
  webflowType: WebflowFieldType;
  airtableTypes: AirtableFieldType[];
  notes?: string;
}[] = [
  { webflowType: 'PlainText', airtableTypes: ['singleLineText'] },
  { webflowType: 'RichText', airtableTypes: ['richText', 'multilineText'] },
  { webflowType: 'Image', airtableTypes: ['multipleAttachments'] },
  { webflowType: 'MultiImage', airtableTypes: ['multipleAttachments'] },
  { webflowType: 'Video', airtableTypes: ['url'] },
  { webflowType: 'VideoLink', airtableTypes: ['url'] },
  { webflowType: 'Link', airtableTypes: ['url'] },
  { webflowType: 'Email', airtableTypes: ['email'] },
  { webflowType: 'Phone', airtableTypes: ['phone'] },
  { webflowType: 'Number', airtableTypes: ['number', 'currency', 'percent'] },
  { webflowType: 'DateTime', airtableTypes: ['date', 'dateTime'] },
  { webflowType: 'Switch', airtableTypes: ['checkbox'] },
  { webflowType: 'Color', airtableTypes: ['singleLineText'] },
  { webflowType: 'Option', airtableTypes: ['singleSelect'] },
  { webflowType: 'File', airtableTypes: ['multipleAttachments'] },
  { webflowType: 'Reference', airtableTypes: ['multipleRecordLinks'] },
  { webflowType: 'MultiReference', airtableTypes: ['multipleRecordLinks'] },
];

export function getCompatibleWebflowTypes(airtableType: AirtableFieldType): WebflowFieldType[] {
  const entry = AIRTABLE_TO_WEBFLOW_COMPAT.find(c => c.airtableType === airtableType);
  return entry?.webflowTypes || [];
}

export function getCompatibleAirtableTypes(webflowType: WebflowFieldType): AirtableFieldType[] {
  const entry = WEBFLOW_TO_AIRTABLE_COMPAT.find(c => c.webflowType === webflowType);
  return entry?.airtableTypes || [];
}

export function isCompatible(airtableType: AirtableFieldType, webflowType: WebflowFieldType): boolean {
  return getCompatibleWebflowTypes(airtableType).includes(webflowType);
}

// ─── Value Conversion: Airtable → Webflow ───────────────────────

export function convertAirtableToWebflow(
  value: unknown,
  mapping: FieldMapping
): unknown {
  if (value === null || value === undefined) return null;

  const { airtable_field_type, webflow_field_type } = mapping;

  // Plain text types
  if (webflow_field_type === 'PlainText') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  // Rich text - pass through markdown/HTML
  if (webflow_field_type === 'RichText') {
    if (typeof value === 'string') return value;
    return String(value);
  }

  // Number
  if (webflow_field_type === 'Number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
      return isNaN(num) ? null : num;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return null;
  }

  // DateTime
  if (webflow_field_type === 'DateTime') {
    if (typeof value === 'string') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }

  // Email, Phone - pass through strings
  if (webflow_field_type === 'Email' || webflow_field_type === 'Phone') {
    return typeof value === 'string' ? value : String(value);
  }

  // Link / Video
  if (webflow_field_type === 'Link' || webflow_field_type === 'Video' || webflow_field_type === 'VideoLink') {
    if (typeof value === 'string') return value;
    // Button fields come as { label, url }
    if (typeof value === 'object' && value !== null && 'url' in value) {
      return (value as { url: string }).url;
    }
    return String(value);
  }

  // Switch
  if (webflow_field_type === 'Switch') {
    return Boolean(value);
  }

  // Color
  if (webflow_field_type === 'Color') {
    return typeof value === 'string' ? value : null;
  }

  // Option (single select)
  if (webflow_field_type === 'Option') {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && 'name' in value) {
      return (value as { name: string }).name;
    }
    return String(value);
  }

  // Image
  if (webflow_field_type === 'Image') {
    if (Array.isArray(value) && value.length > 0) {
      const attachment = value[0] as { url?: string; filename?: string };
      return { url: attachment.url || '', alt: attachment.filename || '' };
    }
    if (typeof value === 'string') return { url: value, alt: '' };
    return null;
  }

  // MultiImage
  if (webflow_field_type === 'MultiImage') {
    if (Array.isArray(value)) {
      return value.map((att: { url?: string; filename?: string }) => ({
        url: att.url || '',
        alt: att.filename || '',
      }));
    }
    return [];
  }

  // File
  if (webflow_field_type === 'File') {
    if (Array.isArray(value) && value.length > 0) {
      const attachment = value[0] as { url?: string; filename?: string };
      return { url: attachment.url || '', name: attachment.filename || '' };
    }
    return null;
  }

  // Reference/MultiReference fields are resolved by the sync engine using
  // linked_connection_id.  If this converter is reached it means no resolution
  // was configured; return null rather than passing raw Airtable record objects
  // to Webflow (which would cause API errors on the Webflow side).
  if (webflow_field_type === 'Reference' || webflow_field_type === 'MultiReference') {
    return null;
  }

  return value;
}

// ─── Value Conversion: Webflow → Airtable ───────────────────────

export function convertWebflowToAirtable(
  value: unknown,
  mapping: FieldMapping
): unknown {
  if (value === null || value === undefined) return null;

  const { airtable_field_type } = mapping;

  // Single line text
  if (airtable_field_type === 'singleLineText') {
    if (typeof value === 'string') return value;
    return String(value);
  }

  // Rich text / multiline
  if (airtable_field_type === 'richText' || airtable_field_type === 'multilineText') {
    if (typeof value === 'string') return value;
    return String(value);
  }

  // Number types
  if (airtable_field_type === 'number' || airtable_field_type === 'currency' || airtable_field_type === 'percent') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const num = parseFloat(value);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  // Date types
  if (airtable_field_type === 'date' || airtable_field_type === 'dateTime') {
    if (typeof value === 'string') return value;
    return null;
  }

  // Email, Phone, URL - string pass through
  if (airtable_field_type === 'email' || airtable_field_type === 'phone' || airtable_field_type === 'url') {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && 'url' in value) {
      return (value as { url: string }).url;
    }
    return String(value);
  }

  // Checkbox
  if (airtable_field_type === 'checkbox') {
    return Boolean(value);
  }

  // Single select
  if (airtable_field_type === 'singleSelect') {
    if (typeof value === 'string') return value;
    return String(value);
  }

  // Attachments (from Image, MultiImage, File)
  if (airtable_field_type === 'multipleAttachments') {
    if (Array.isArray(value)) {
      return value.map((item: { url?: string; alt?: string; name?: string }) => ({
        url: item.url || '',
        filename: item.alt || item.name || '',
      }));
    }
    if (typeof value === 'object' && value !== null && 'url' in value) {
      const img = value as { url: string; alt?: string; name?: string };
      return [{ url: img.url, filename: img.alt || img.name || '' }];
    }
    return [];
  }

  // Record links are resolved by the sync engine using linked_connection_id.
  // If this converter is reached for a multipleRecordLinks field it means no
  // resolution was configured; returning null is safer than passing raw
  // Webflow item IDs (which would cause INVALID_RECORD_ID errors in Airtable).
  if (airtable_field_type === 'multipleRecordLinks') {
    return null;
  }

  return value;
}
