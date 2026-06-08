import { and, eq } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { db } from '@main/db/client';
import { organizationSettings } from '@main/db/schema';
import { computeTrueOverrides, mergeDeep } from './utils';

/**
 * A per-organization override store layered on top of static external defaults.
 * Overrides are persisted as a single JSON blob per organization in the
 * `organization_settings` table, keyed by `(organizationId, storageKey)`. Each
 * organization keeps its own overrides and its own in-memory cache entry.
 */
export class OverrideSettings<TConfig extends object> {
  private readonly cache = new Map<string, Record<string, TConfig>>();

  constructor(
    private readonly storageKey: string,
    private readonly getExternalDefaults: () => Record<string, TConfig>,
    private readonly itemSchema: ZodType<Partial<TConfig>>,
    private readonly normalizeStoredOverrides: (
      overrides: Record<string, Partial<TConfig>>
    ) => Record<string, Partial<TConfig>> = (overrides) => overrides
  ) {}

  private async readRawOverrides(
    organizationId: string
  ): Promise<Record<string, Partial<TConfig>>> {
    const [row] = await db
      .select()
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, organizationId),
          eq(organizationSettings.key, this.storageKey)
        )
      )
      .execute();
    if (!row) return {};
    try {
      return this.normalizeStoredOverrides(
        JSON.parse(row.value) as Record<string, Partial<TConfig>>
      );
    } catch {
      return {};
    }
  }

  private async storeOverrides(
    organizationId: string,
    overrides: Record<string, Partial<TConfig>>
  ): Promise<void> {
    if (Object.keys(overrides).length === 0) {
      await db
        .delete(organizationSettings)
        .where(
          and(
            eq(organizationSettings.organizationId, organizationId),
            eq(organizationSettings.key, this.storageKey)
          )
        )
        .execute();
    } else {
      const serialized = JSON.stringify(overrides);
      await db
        .insert(organizationSettings)
        .values({ organizationId, key: this.storageKey, value: serialized, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [organizationSettings.organizationId, organizationSettings.key],
          set: { value: serialized, updatedAt: Date.now() },
        })
        .execute();
    }
    this.cache.delete(organizationId);
  }

  async getAll(organizationId: string): Promise<Record<string, TConfig>> {
    const cached = this.cache.get(organizationId);
    if (cached) return cached;

    const externalDefaults = this.getExternalDefaults();
    const storedOverrides = await this.readRawOverrides(organizationId);
    const result: Record<string, TConfig> = {};
    const allIds = new Set([...Object.keys(externalDefaults), ...Object.keys(storedOverrides)]);

    for (const id of allIds) {
      const def = (externalDefaults[id] ?? {}) as Record<string, unknown>;
      const override = (storedOverrides[id] ?? {}) as Record<string, unknown>;
      result[id] = mergeDeep(def, override) as TConfig;
    }

    this.cache.set(organizationId, result);
    return result;
  }

  async getItem(organizationId: string, id: string): Promise<TConfig | undefined> {
    const all = await this.getAll(organizationId);
    return all[id];
  }

  async getItemWithMeta(
    organizationId: string,
    id: string
  ): Promise<{
    value: TConfig;
    defaults: TConfig;
    overrides: Partial<TConfig>;
  } | null> {
    const externalDefaults = this.getExternalDefaults();
    const defaults = externalDefaults[id];
    if (!defaults) return null;

    const storedOverrides = await this.readRawOverrides(organizationId);
    const itemOverrides = (storedOverrides[id] ?? {}) as Record<string, unknown>;
    const trueOverrides = computeTrueOverrides(
      itemOverrides,
      defaults as Record<string, unknown>
    ) as Partial<TConfig>;
    const value = mergeDeep(defaults as Record<string, unknown>, itemOverrides) as TConfig;

    return { value, defaults, overrides: trueOverrides };
  }

  async updateItem(organizationId: string, id: string, config: Partial<TConfig>): Promise<void> {
    const externalDefaults = this.getExternalDefaults();
    const defaults = (externalDefaults[id] ?? {}) as Record<string, unknown>;
    const validated = this.itemSchema.parse(config) as Record<string, unknown>;
    const delta = computeTrueOverrides(validated, defaults) as Partial<TConfig>;

    const storedOverrides = await this.readRawOverrides(organizationId);
    if (Object.keys(delta).length === 0) {
      delete storedOverrides[id];
    } else {
      storedOverrides[id] = delta;
    }
    await this.storeOverrides(organizationId, storedOverrides);
  }

  async resetItem(organizationId: string, id: string): Promise<void> {
    const storedOverrides = await this.readRawOverrides(organizationId);
    delete storedOverrides[id];
    await this.storeOverrides(organizationId, storedOverrides);
  }

  async resetAll(organizationId: string): Promise<void> {
    await db
      .delete(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, organizationId),
          eq(organizationSettings.key, this.storageKey)
        )
      )
      .execute();
    this.cache.delete(organizationId);
  }
}
