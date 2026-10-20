import type { Element, Node } from "@xmldom/xmldom";

import { parseXmlDocument } from "../domain/xmlDocument.js";

/** Component kinds a decoded AndroidManifest can declare under <application>. */
export const ANDROID_COMPONENT_KINDS = [
  "activity",
  "activity-alias",
  "service",
  "receiver",
  "provider",
] as const;
export type AndroidComponentKind = (typeof ANDROID_COMPONENT_KINDS)[number];

/** Bounds keep a hostile manifest from exhausting the inspection. */
export const ANDROID_MANIFEST_LIMITS = {
  components: 512,
  intentFilters: 32,
  intentValues: 64,
  authorities: 64,
  /** Total bytes of resolved component names, bounding package amplification. */
  resolvedNameBytes: 1024 * 1024,
} as const;

/** The attribute namespace every component facet uses. */
const ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";

export interface AndroidManifestComponent {
  readonly kind: AndroidComponentKind;
  /** Class name as written in the manifest. */
  readonly declared_name: string;
  /**
   * Fully qualified name with the manifest package applied, or the declared
   * name unchanged when the resolved-name byte budget was exhausted.
   */
  readonly name: string;
  /** Declared android:exported, or null when the attribute is absent. */
  readonly exported: boolean | null;
  /**
   * Android's default export state when android:exported is absent: the
   * intent-filter rule for activities, services, receivers and aliases, and
   * the target-SDK rule for providers. Null when the provider rule cannot be
   * evaluated because the target SDK is unknown.
   */
  readonly exported_default: boolean | null;
  readonly permission: string | null;
  readonly intent_filter_count: number;
  readonly actions: readonly string[];
  readonly categories: readonly string[];
  /** Declared android:foregroundServiceType on services; null otherwise. */
  readonly foreground_service_type: string | null;
  /** Declared android:authorities on providers, split on ";". */
  readonly authorities: readonly string[] | null;
  /** Declared android:targetActivity on activity-alias. */
  readonly target_activity: string | null;
}

export interface AndroidManifestComponentInventory {
  readonly status: "complete" | "partial" | "unavailable";
  readonly items: readonly AndroidManifestComponent[];
  readonly limitations: readonly string[];
}

const PARTIAL_LIMITATION =
  "The decoded manifest text is truncated, so its component inventory is not established; the retained manifest is partial.";

const unavailable = (
  limitation: string,
): AndroidManifestComponentInventory => ({
  status: "unavailable",
  items: [],
  limitations: [limitation],
});

const childNodes = (element: Element): readonly Node[] =>
  Array.from(element.childNodes);

/** Read an unnamespaced attribute, the shape manifest `package` uses. */
const plainAttribute = (element: Element, name: string): string | null => {
  const value = element.getAttribute(name);
  return value === "" ? null : value;
};

/**
 * Read an android-namespaced attribute. XML prefixes are aliases, so a
 * same-local-name attribute from another namespace is never a match.
 */
const androidAttribute = (
  element: Element,
  localName: string,
): string | null => {
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const node = attributes.item(index);
    if (node === null || node.localName !== localName) continue;
    if (node.namespaceURI === ANDROID_NAMESPACE) return node.nodeValue;
    // Without namespace information (an undeclared prefix), the conventional
    // android: prefix is the only remaining signal.
    if (node.namespaceURI === null && node.prefix === "android")
      return node.nodeValue;
  }
  return null;
};

const booleanAttribute = (element: Element, name: string): boolean | null => {
  const value = androidAttribute(element, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};

const trimmed = (element: Element, name: string): string | null => {
  const value = androidAttribute(element, name)?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

/**
 * Android resolves a component name against the manifest package: a leading
 * dot or a name without any dot is relative to the package, while a dotted
 * name is already fully qualified.
 */
export const resolveAndroidComponentName = (
  packageName: string | null,
  declared: string,
): string => {
  if (declared.startsWith(".")) return `${packageName ?? ""}${declared}`;
  if (!declared.includes(".") && packageName !== null)
    return `${packageName}.${declared}`;
  return declared;
};

const isComponentKind = (tag: string): tag is AndroidComponentKind =>
  (ANDROID_COMPONENT_KINDS as readonly string[]).includes(tag);

/**
 * Android's target-SDK rule for an absent android:exported on providers:
 * exported through API 16, not exported from API 17.
 */
export const providerExportedDefault = (
  targetSdk: string | null,
): boolean | null => {
  if (targetSdk === null) return null;
  const level = Number(targetSdk);
  if (!Number.isInteger(level) || level < 1) return null;
  return level <= 16;
};

/**
 * Collect unique intent-filter actions and categories. The value budget is
 * shared across both arrays, matching the stated per-component bound.
 */
const intentValues = (
  filters: readonly Element[],
): { actions: string[]; categories: string[]; truncated: boolean } => {
  const actions: string[] = [];
  const categories: string[] = [];
  let truncated = filters.length > ANDROID_MANIFEST_LIMITS.intentFilters;
  let budget = ANDROID_MANIFEST_LIMITS.intentValues;
  for (const filter of filters.slice(0, ANDROID_MANIFEST_LIMITS.intentFilters))
    for (const member of childNodes(filter)) {
      if (member.nodeType !== 1) continue;
      const element = member as Element;
      if (element.nodeName !== "action" && element.nodeName !== "category")
        continue;
      const value = trimmed(element, "name");
      if (value === null) continue;
      const target = element.nodeName === "action" ? actions : categories;
      if (target.includes(value)) continue;
      if (budget <= 0) {
        truncated = true;
        continue;
      }
      budget -= 1;
      target.push(value);
    }
  return { actions, categories, truncated };
};

/** Split a provider authorities declaration within its own bound. */
const providerAuthorities = (
  declared: string,
): { authorities: string[]; truncated: boolean } => {
  const authorities: string[] = [];
  let truncated = false;
  for (const value of declared.split(";")) {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) continue;
    if (authorities.length >= ANDROID_MANIFEST_LIMITS.authorities) {
      truncated = true;
      break;
    }
    authorities.push(trimmedValue);
  }
  return { authorities, truncated };
};

/**
 * Parse the decoded AndroidManifest XML text into a bounded, deterministic
 * component inventory. The projection is static: it reports declarations and
 * Android's documented export defaults, never merged-manifest or runtime
 * state.
 */
export const parseAndroidManifestComponents = (
  manifestText: string,
  coverage: "complete" | "partial",
  targetSdk: string | null = null,
): AndroidManifestComponentInventory => {
  if (coverage === "partial")
    return {
      status: "partial",
      items: [],
      limitations: [PARTIAL_LIMITATION],
    };
  const parsed = parseXmlDocument(manifestText, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok)
    return unavailable(
      `The decoded manifest is not well-formed XML (${parsed.error.reason}), so its component inventory is unavailable.`,
    );
  const root = parsed.value.documentElement;
  if (root === null || root.nodeName !== "manifest")
    return unavailable(
      "The decoded manifest root is not <manifest>, so its component inventory is unavailable.",
    );
  const packageName = plainAttribute(root, "package")?.trim() || null;
  const limitations: string[] = [];
  const items: AndroidManifestComponent[] = [];
  let truncated = false;
  let applicationSeen = false;
  let unnamed = 0;
  let providerDefaultsUnknown = 0;
  let unresolvedNames = 0;
  let nameBudget = ANDROID_MANIFEST_LIMITS.resolvedNameBytes;
  for (const node of childNodes(root)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.nodeName !== "application") continue;
    applicationSeen = true;
    for (const child of childNodes(element)) {
      if (child.nodeType !== 1) continue;
      const component = child as Element;
      if (!isComponentKind(component.nodeName)) continue;
      // Every declaration counts against the bound, named or not, so an
      // unnamed flood cannot exceed it while still reporting complete.
      if (items.length + unnamed >= ANDROID_MANIFEST_LIMITS.components) {
        truncated = true;
        break;
      }
      const declared = trimmed(component, "name");
      if (declared === null) {
        unnamed += 1;
        continue;
      }
      const filters = childNodes(component).filter(
        (entry): entry is Element =>
          entry.nodeType === 1 && entry.nodeName === "intent-filter",
      );
      const collected = intentValues(filters);
      if (collected.truncated) truncated = true;
      // A huge manifest package would be copied into every resolved name;
      // once the byte budget is spent, later names keep their declared form.
      const resolved = resolveAndroidComponentName(packageName, declared);
      const name =
        nameBudget >= resolved.length || items.length === 0
          ? resolved
          : declared;
      if (name !== resolved) unresolvedNames += 1;
      else nameBudget -= resolved.length;
      let authorities: readonly string[] | null = null;
      if (component.nodeName === "provider") {
        const declaredAuthorities = trimmed(component, "authorities");
        if (declaredAuthorities !== null) {
          const split = providerAuthorities(declaredAuthorities);
          if (split.truncated) truncated = true;
          authorities = split.authorities;
        }
      }
      const providerDefault =
        component.nodeName === "provider"
          ? providerExportedDefault(targetSdk)
          : null;
      // The default only matters when android:exported is absent.
      if (
        component.nodeName === "provider" &&
        providerDefault === null &&
        booleanAttribute(component, "exported") === null
      )
        providerDefaultsUnknown += 1;
      items.push({
        kind: component.nodeName,
        declared_name: declared,
        name,
        exported: booleanAttribute(component, "exported"),
        exported_default:
          component.nodeName === "provider"
            ? providerDefault
            : filters.length > 0,
        permission: trimmed(component, "permission"),
        intent_filter_count: filters.length,
        actions: collected.actions,
        categories: collected.categories,
        foreground_service_type:
          component.nodeName === "service"
            ? trimmed(component, "foregroundServiceType")
            : null,
        authorities,
        target_activity:
          component.nodeName === "activity-alias"
            ? trimmed(component, "targetActivity")
            : null,
      });
    }
  }
  if (!applicationSeen)
    limitations.push(
      "The manifest declares no <application> element, so no components were projected.",
    );
  // Dropped declarations mean the inventory is not the whole manifest.
  if (unnamed > 0) {
    limitations.push(
      `${String(unnamed)} component declaration(s) without android:name are omitted from the inventory.`,
    );
    truncated = true;
  }
  if (providerDefaultsUnknown > 0)
    limitations.push(
      `${String(providerDefaultsUnknown)} provider(s) omit android:exported and the target SDK is unknown, so Android's export default for them is not established.`,
    );
  if (unresolvedNames > 0) {
    limitations.push(
      `${String(unresolvedNames)} component name(s) keep their declared form because the resolved-name byte budget (${String(ANDROID_MANIFEST_LIMITS.resolvedNameBytes)}) was exhausted.`,
    );
    truncated = true;
  }
  if (truncated)
    limitations.push(
      `The component inventory stops at ${String(ANDROID_MANIFEST_LIMITS.components)} components, ${String(ANDROID_MANIFEST_LIMITS.intentFilters)} intent filters per component, ${String(ANDROID_MANIFEST_LIMITS.intentValues)} intent-filter values per component, or ${String(ANDROID_MANIFEST_LIMITS.authorities)} authorities per provider.`,
    );
  return {
    status: truncated ? "partial" : "complete",
    items,
    limitations,
  };
};
