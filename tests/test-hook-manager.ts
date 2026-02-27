/**
 * Tests for HookManager — hook file resolution, template substitution,
 * and the hooksDir fix (hook files are resolved from the bot's codebase
 * directory, not from the runtime workDir).
 *
 * These tests exercise file lookup and template logic without spawning
 * a real Claude Code process.
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join } from "node:path";
import { HookManager, type HookManagerDeps } from "../hooks/hook-manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory with optional hook files written into it. */
async function makeTempHooksDir(
  hooks: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [name, content] of Object.entries(hooks)) {
    await Deno.writeTextFile(join(dir, `${name}.md`), content);
  }
  return dir;
}

function makeDeps(overrides: Partial<HookManagerDeps> = {}): HookManagerDeps {
  return {
    workDir: "/some/work/dir",
    sendClaudeMessages: async () => {},
    ...overrides,
  };
}

/** Access private methods/fields for unit testing. */
function getPrivate(hm: HookManager) {
  return hm as unknown as {
    hooksDir: string;
    workDir: string;
    readHookFile: (path: string) => Promise<string | null>;
    applyTemplate: (content: string, vars: Record<string, string>) => string;
  };
}

// ---------------------------------------------------------------------------
// 1. hooksDir resolution
// ---------------------------------------------------------------------------

Deno.test("defaults hooksDir to import.meta.dirname of the module", () => {
  const hm = new HookManager(makeDeps());
  const { hooksDir } = getPrivate(hm);
  // Should point to the hooks/ directory in the codebase, NOT the workDir
  assertStringIncludes(hooksDir, "hooks");
  assertEquals(hooksDir === "/some/work/dir", false);
});

Deno.test("accepts a custom hooksDir", () => {
  const hm = new HookManager(makeDeps({ hooksDir: "/custom/hooks" }));
  assertEquals(getPrivate(hm).hooksDir, "/custom/hooks");
});

// ---------------------------------------------------------------------------
// 2. readHookFile (private, tested directly)
// ---------------------------------------------------------------------------

Deno.test("readHookFile returns content when file exists", async () => {
  const dir = await makeTempHooksDir({ "test-event": "hook content" });
  try {
    const hm = new HookManager(makeDeps({ hooksDir: dir }));
    const content = await getPrivate(hm).readHookFile(join(dir, "test-event.md"));
    assertEquals(content, "hook content");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readHookFile returns null when file is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const hm = new HookManager(makeDeps({ hooksDir: dir }));
    const content = await getPrivate(hm).readHookFile(join(dir, "nope.md"));
    assertEquals(content, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. applyTemplate (private, tested directly)
// ---------------------------------------------------------------------------

Deno.test("applyTemplate replaces all variables", () => {
  const hm = new HookManager(makeDeps());
  const apply = getPrivate(hm).applyTemplate.bind(hm);

  assertEquals(
    apply("Hello {{name}}, welcome to {{place}}!", { name: "Alice", place: "Wonderland" }),
    "Hello Alice, welcome to Wonderland!",
  );
});

Deno.test("applyTemplate leaves unknown variables untouched", () => {
  const hm = new HookManager(makeDeps());
  const apply = getPrivate(hm).applyTemplate.bind(hm);

  assertEquals(
    apply("{{known}} and {{unknown}}", { known: "yes" }),
    "yes and {{unknown}}",
  );
});

Deno.test("applyTemplate handles empty variables", () => {
  const hm = new HookManager(makeDeps());
  const apply = getPrivate(hm).applyTemplate.bind(hm);

  assertEquals(apply("no variables here", {}), "no variables here");
});

Deno.test("applyTemplate handles multiple occurrences of same variable", () => {
  const hm = new HookManager(makeDeps());
  const apply = getPrivate(hm).applyTemplate.bind(hm);

  assertEquals(
    apply("{{x}} + {{x}} = 2{{x}}", { x: "1" }),
    "1 + 1 = 21",
  );
});

// ---------------------------------------------------------------------------
// 4. executeHook — file-not-found path (no Claude spawn)
// ---------------------------------------------------------------------------

Deno.test("executeHook returns false when hook file does not exist", async () => {
  const emptyDir = await Deno.makeTempDir();
  try {
    const hm = new HookManager(makeDeps({ hooksDir: emptyDir }));
    assertEquals(await hm.executeHook("nonexistent", {}), false);
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
  }
});

Deno.test("executeHook does NOT look in workDir/hooks/ for hook files", async () => {
  // Put a hook file in workDir/hooks/ (old broken behavior)
  const workDir = await Deno.makeTempDir();
  const workDirHooks = join(workDir, "hooks");
  await Deno.mkdir(workDirHooks);
  await Deno.writeTextFile(join(workDirHooks, "test-event.md"), "should not be found");

  // hooksDir is empty — no hook files there
  const emptyHooksDir = await Deno.makeTempDir();

  try {
    const hm = new HookManager(makeDeps({ workDir, hooksDir: emptyHooksDir }));
    // Must return false: hooksDir has no test-event.md,
    // even though workDir/hooks/test-event.md exists
    assertEquals(await hm.executeHook("test-event", {}), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(emptyHooksDir, { recursive: true });
  }
});

Deno.test("executeHook does NOT look in workDirOverride/hooks/ for hook files", async () => {
  const overrideDir = await Deno.makeTempDir();
  await Deno.mkdir(join(overrideDir, "hooks"));
  await Deno.writeTextFile(join(overrideDir, "hooks", "sneaky.md"), "should not run");

  const emptyHooksDir = await Deno.makeTempDir();

  try {
    const hm = new HookManager(makeDeps({ hooksDir: emptyHooksDir }));
    assertEquals(await hm.executeHook("sneaky", {}, overrideDir), false);
  } finally {
    await Deno.remove(overrideDir, { recursive: true });
    await Deno.remove(emptyHooksDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 5. executeHook — file lookup uses hooksDir (verify via readHookFile path)
// ---------------------------------------------------------------------------

Deno.test("hook file is resolved from hooksDir, not workDir", async () => {
  const hooksDir = await makeTempHooksDir({ "my-hook": "content here" });
  const workDir = await Deno.makeTempDir(); // different dir, no hooks

  try {
    const hm = new HookManager(makeDeps({ workDir, hooksDir }));
    const priv = getPrivate(hm);

    // The path that executeHook would construct
    const hookPath = join(priv.hooksDir, "my-hook.md");
    const content = await priv.readHookFile(hookPath);
    assertEquals(content, "content here");

    // Verify that using workDir path would NOT find it
    const badPath = join(workDir, "hooks", "my-hook.md");
    const noContent = await priv.readHookFile(badPath);
    assertEquals(noContent, null);
  } finally {
    await Deno.remove(hooksDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 6. resetProgress behavior on missing hook (no Claude spawn)
// ---------------------------------------------------------------------------

Deno.test("executeHook does NOT call resetProgress when hook file is missing", async () => {
  const emptyDir = await Deno.makeTempDir();
  let resetCalled = false;

  try {
    const hm = new HookManager(makeDeps({
      hooksDir: emptyDir,
      resetProgress: () => {
        resetCalled = true;
      },
    }));
    await hm.executeHook("missing", {});
    assertEquals(resetCalled, false);
  } finally {
    await Deno.remove(emptyDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 7. effectiveWorkDir logic
// ---------------------------------------------------------------------------

Deno.test("effectiveWorkDir uses workDir when no override given", () => {
  const hm = new HookManager(makeDeps({ workDir: "/main/repo" }));
  assertEquals(getPrivate(hm).workDir, "/main/repo");
});
