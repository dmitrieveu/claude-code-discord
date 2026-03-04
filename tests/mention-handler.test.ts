import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import { parseMentionCommand } from "../discord/mention-handler.ts";

// Mock Discord.js types
const mockMessage = (content: string) => ({
  content,
  mentions: {
    has: (id: string) => content.includes(`<@${id}`),
  },
  attachments: {
    size: 0,
  },
});

const mockClient = {
  user: {
    id: "123456789",
  },
};

const mockHandlers = new Map([
  ["status", { execute: () => {} }],
  ["help", { execute: () => {} }],
  ["git-status", { execute: () => {} }],
  ["shell", { execute: () => {} }],
  ["continue", { execute: () => {} }],
]);

Deno.test("parseMentionCommand - handles slash commands", () => {
  const message = mockMessage("<@123456789> /status");
  const result = parseMentionCommand(
    message as any,
    mockClient as any,
    mockHandlers as any
  );
  
  assertEquals(result?.command, "status");
  assertEquals(result?.prompt, "");
  assertEquals(result?.hasAttachment, false);
});

Deno.test("parseMentionCommand - handles slash commands with arguments", () => {
  const message = mockMessage("<@123456789> /shell ls -la");
  const result = parseMentionCommand(
    message as any,
    mockClient as any,
    mockHandlers as any
  );
  
  assertEquals(result?.command, "shell");
  assertEquals(result?.prompt, "ls -la");
  assertEquals(result?.hasAttachment, false);
});

Deno.test("parseMentionCommand - falls back to hardcoded routes", () => {
  const message = mockMessage("<@123456789> git status");
  const result = parseMentionCommand(
    message as any,
    mockClient as any,
    mockHandlers as any
  );
  
  assertEquals(result?.command, "git-status");
  assertEquals(result?.prompt, "");
  assertEquals(result?.hasAttachment, false);
});

Deno.test("parseMentionCommand - defaults to continue for unknown commands", () => {
  const message = mockMessage("<@123456789> some random text");
  const result = parseMentionCommand(
    message as any,
    mockClient as any,
    mockHandlers as any
  );
  
  assertEquals(result?.command, "continue");
  assertEquals(result?.prompt, "some random text");
  assertEquals(result?.hasAttachment, false);
});

Deno.test("parseMentionCommand - handles unknown slash commands", () => {
  const message = mockMessage("<@123456789> /unknowncommand arg1 arg2");
  const result = parseMentionCommand(
    message as any,
    mockClient as any,
    mockHandlers as any
  );
  
  // Unknown slash command should fall through to continue
  assertEquals(result?.command, "continue");
  assertEquals(result?.prompt, "/unknowncommand arg1 arg2");
  assertEquals(result?.hasAttachment, false);
});