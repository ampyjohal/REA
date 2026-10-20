import { expect, it } from "vitest";

import {
  ANDROID_MANIFEST_LIMITS,
  parseAndroidManifestComponents,
  resolveAndroidComponentName,
} from "../../../src/android/AndroidManifestComponents.js";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
  <application android:label="Example">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
    <activity android:name="DetailActivity">
      <intent-filter>
        <action android:name="com.example.app.OPEN_DETAIL" />
      </intent-filter>
    </activity>
    <activity android:name="com.example.app.HiddenActivity" android:exported="false">
      <intent-filter>
        <action android:name="com.example.app.HIDDEN" />
      </intent-filter>
    </activity>
    <activity-alias
      android:name=".AliasActivity"
      android:targetActivity=".MainActivity"
      android:exported="true" />
    <service
      android:name=".SyncService"
      android:permission="com.example.app.SYNC"
      android:foregroundServiceType="dataSync" />
    <receiver android:name=".BootReceiver">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
      </intent-filter>
    </receiver>
    <provider
      android:name=".DataProvider"
      android:authorities="com.example.app.data;com.example.app.backup"
      android:exported="false" />
    <meta-data android:name="ignored" android:value="not-a-component" />
  </application>
</manifest>`;

it("projects declared components with resolved names and export defaults", () => {
  const inventory = parseAndroidManifestComponents(MANIFEST, "complete", "33");
  expect(inventory.status).toBe("complete");
  expect(inventory.limitations).toEqual([]);
  expect(inventory.items.map(({ kind, name }) => [kind, name])).toEqual([
    ["activity", "com.example.app.MainActivity"],
    ["activity", "com.example.app.DetailActivity"],
    ["activity", "com.example.app.HiddenActivity"],
    ["activity-alias", "com.example.app.AliasActivity"],
    ["service", "com.example.app.SyncService"],
    ["receiver", "com.example.app.BootReceiver"],
    ["provider", "com.example.app.DataProvider"],
  ]);
  expect(inventory.items[0]).toMatchObject({
    declared_name: ".MainActivity",
    exported: true,
    exported_default: true,
    actions: ["android.intent.action.MAIN"],
    categories: ["android.intent.category.LAUNCHER"],
  });
  // Absent android:exported keeps the declaration and the default separate.
  expect(inventory.items[1]).toMatchObject({
    exported: null,
    exported_default: true,
  });
  expect(inventory.items[2]).toMatchObject({
    exported: false,
    exported_default: true,
  });
  expect(inventory.items[3]).toMatchObject({
    target_activity: ".MainActivity",
  });
  expect(inventory.items[4]).toMatchObject({
    permission: "com.example.app.SYNC",
    foreground_service_type: "dataSync",
    actions: [],
  });
  expect(inventory.items[5]).toMatchObject({
    actions: ["android.intent.action.BOOT_COMPLETED"],
    categories: [],
  });
  expect(inventory.items[6]?.authorities).toEqual([
    "com.example.app.data",
    "com.example.app.backup",
  ]);
});

it("applies the provider export default from the target SDK", () => {
  // API 16 and below default providers to exported; API 17 and up do not.
  const legacy = parseAndroidManifestComponents(MANIFEST, "complete", "16");
  expect(legacy.items[6]).toMatchObject({
    kind: "provider",
    exported: false,
    exported_default: true,
  });
  const modern = parseAndroidManifestComponents(MANIFEST, "complete", "33");
  expect(modern.items[6]?.exported_default).toBe(false);
  // An unknown target SDK leaves the provider default unestablished; this
  // manifest's provider declares android:exported, so no limitation fires.
  // The omitted-exported warning path is covered by its own test.
  const unknown = parseAndroidManifestComponents(MANIFEST, "complete", null);
  expect(unknown.items[6]?.exported_default).toBeNull();
  expect(unknown.limitations).toEqual([]);
});

it("ignores same-local-name attributes from other namespaces", () => {
  const manifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    '          xmlns:vendor="http://example.com/vendor"',
    '          package="com.example.app">',
    "  <application>",
    '    <activity vendor:name=".Decoy" android:name=".Real" vendor:exported="true" android:exported="false" />',
    "  </application>",
    "</manifest>",
  ].join("\n");
  const inventory = parseAndroidManifestComponents(manifest, "complete", "33");
  expect(inventory.items).toHaveLength(1);
  expect(inventory.items[0]).toMatchObject({
    declared_name: ".Real",
    name: "com.example.app.Real",
    exported: false,
    exported_default: false,
  });
});

it("resolves relative names against the manifest package", () => {
  expect(resolveAndroidComponentName("com.example.app", ".Main")).toBe(
    "com.example.app.Main",
  );
  expect(resolveAndroidComponentName("com.example.app", "Main")).toBe(
    "com.example.app.Main",
  );
  expect(resolveAndroidComponentName("com.example.app", "org.other.Main")).toBe(
    "org.other.Main",
  );
  expect(resolveAndroidComponentName(null, ".Main")).toBe(".Main");
});

it("does not establish a component inventory from truncated manifest text", () => {
  const inventory = parseAndroidManifestComponents(MANIFEST, "partial");
  expect(inventory.status).toBe("partial");
  expect(inventory.items).toEqual([]);
  expect(inventory.limitations[0]).toContain("truncated");
});

it("reports unavailable inventory for malformed or unexpected manifests", () => {
  expect(
    parseAndroidManifestComponents("<manifest><application>", "complete"),
  ).toMatchObject({ status: "unavailable", items: [] });
  expect(
    parseAndroidManifestComponents(
      '<?xml version="1.0" encoding="utf-8"?><resources />',
      "complete",
    ),
  ).toMatchObject({ status: "unavailable", items: [] });
  expect(
    parseAndroidManifestComponents(
      '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE manifest><manifest />',
      "complete",
    ),
  ).toMatchObject({ status: "unavailable", items: [] });
});

it("bounds the component inventory and says so", () => {
  const repeated = Array.from(
    { length: ANDROID_MANIFEST_LIMITS.components + 1 },
    (_, index) => `<activity android:name=".Activity${String(index)}" />`,
  ).join("");
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application>${repeated}</application></manifest>`,
    "complete",
    "33",
  );
  expect(inventory.status).toBe("partial");
  expect(inventory.items).toHaveLength(ANDROID_MANIFEST_LIMITS.components);
  expect(inventory.limitations.join(" ")).toContain(
    String(ANDROID_MANIFEST_LIMITS.components),
  );
});

it("shares one intent-value budget across actions and categories", () => {
  const values = Array.from(
    { length: 80 },
    (_, index) =>
      `<intent-filter><action android:name="a${String(index)}" /><category android:name="c${String(index)}" /></intent-filter>`,
  ).join("");
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity android:name=".Many">${values}</activity></application></manifest>`,
    "complete",
    "33",
  );
  const first = inventory.items[0];
  expect(first).toBeDefined();
  expect((first?.actions.length ?? 0) + (first?.categories.length ?? 0)).toBe(
    ANDROID_MANIFEST_LIMITS.intentValues,
  );
  expect(inventory.status).toBe("partial");
  expect(inventory.limitations.join(" ")).toContain("values per component");
});

it("bounds provider authorities", () => {
  const authorities = Array.from(
    { length: ANDROID_MANIFEST_LIMITS.authorities + 5 },
    (_, index) => `auth${String(index)}`,
  ).join(";");
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><provider android:name=".Many" android:authorities="${authorities}" /></application></manifest>`,
    "complete",
    "33",
  );
  expect(inventory.items[0]?.authorities).toHaveLength(
    ANDROID_MANIFEST_LIMITS.authorities,
  );
  expect(inventory.status).toBe("partial");
});

it("leaves later names declared when the resolved-name budget is spent", () => {
  const hugePackage = "p".repeat(64 * 1024);
  const names = Array.from(
    { length: 20 },
    (_, index) => `<activity android:name=".A${String(index)}" />`,
  ).join("");
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${hugePackage}"><application>${names}</application></manifest>`,
    "complete",
    "33",
  );
  expect(inventory.items.length).toBeGreaterThan(1);
  expect(inventory.items[0]?.name).toContain(hugePackage);
  const unresolved = inventory.items.filter(
    ({ name }) => !name.includes(hugePackage),
  );
  expect(unresolved.length).toBeGreaterThan(0);
  expect(unresolved.every(({ name }) => name.startsWith(".A"))).toBe(true);
  expect(inventory.status).toBe("partial");
  expect(inventory.limitations.join(" ")).toContain(
    "resolved-name byte budget",
  );
});

it("marks the inventory partial when nameless declarations are dropped", () => {
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><activity /><activity android:name=".Real" /></application></manifest>`,
    "complete",
    "33",
  );
  expect(inventory.status).toBe("partial");
  expect(inventory.items).toHaveLength(1);
  expect(inventory.limitations.join(" ")).toContain(
    "1 component declaration(s) without android:name",
  );
});

it("does not warn about providers that declare android:exported", () => {
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application><provider android:name=".Declared" android:exported="false" /><provider android:name=".Omitted" /></application></manifest>`,
    "complete",
    null,
  );
  expect(inventory.limitations.join(" ")).toContain("1 provider(s) omit");
  expect(inventory.limitations.join(" ")).not.toContain("2 provider(s) omit");
});

it("counts unnamed declarations against the component bound", () => {
  const unnamed = Array.from(
    { length: ANDROID_MANIFEST_LIMITS.components + 1 },
    () => "<activity />",
  ).join("");
  const inventory = parseAndroidManifestComponents(
    `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app"><application>${unnamed}</application></manifest>`,
    "complete",
    "33",
  );
  expect(inventory.status).toBe("partial");
  expect(inventory.items).toHaveLength(0);
  expect(inventory.limitations.join(" ")).toContain(
    `${String(ANDROID_MANIFEST_LIMITS.components)} component`,
  );
});
