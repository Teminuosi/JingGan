import type { CharacterCandidate } from './types';

type RoleMapping = Pick<CharacterCandidate, 'source_role_id' | 'character_id'>;

function normalizeText(text: string, mappings: RoleMapping[]): string {
  return mappings.reduce((normalized, mapping) => normalized.replace(
    new RegExp(`\\b${mapping.source_role_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
    mapping.character_id,
  ), text);
}

export function normalizeKnownSourceRoleReferences<T>(value: T, mappings: RoleMapping[]): T {
  if (typeof value === 'string') return normalizeText(value, mappings) as T;
  if (Array.isArray(value)) return value.map((item) => normalizeKnownSourceRoleReferences(item, mappings)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalizeKnownSourceRoleReferences(item, mappings),
    ])) as T;
  }
  return value;
}
