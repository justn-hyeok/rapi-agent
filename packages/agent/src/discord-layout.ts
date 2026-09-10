import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const roleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(100),
  permissions: z.array(z.enum(["ADMINISTRATOR"])).default([]),
  color: z.number().int().min(0).max(0xffffff).default(0),
  hoist: z.boolean().default(false),
});

const channelSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(100),
  type: z.enum(["text", "voice"]),
  topic: z.string().max(1024).optional(),
  readOnly: z.boolean().default(false),
});

const categorySchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(100),
  audience: z.enum(["everyone", "user", "staff"]),
  channels: z.array(channelSchema),
});

const layoutSchema = z.object({
  version: z.literal(1),
  replaceExistingChannels: z.boolean().default(true),
  roles: z.array(roleSchema),
  categories: z.array(categorySchema),
});

export type DiscordLayout = z.infer<typeof layoutSchema>;

export const defaultCommunityLayout: DiscordLayout = {
  version: 1,
  replaceExistingChannels: true,
  roles: [
    {
      key: "rapi_user",
      name: "라피 USER",
      permissions: [],
      color: 0x5865f2,
      hoist: false,
    },
    {
      key: "rapi_staff",
      name: "라피 운영진",
      permissions: ["ADMINISTRATOR"],
      color: 0xfee75c,
      hoist: true,
    },
  ],
  categories: [
    {
      key: "getting_started",
      name: "시작하기",
      audience: "everyone",
      channels: [
        { key: "announcements", name: "공지", type: "text", readOnly: true },
        { key: "rules", name: "규칙", type: "text", readOnly: true },
        {
          key: "roles",
          name: "역할-받기",
          type: "text",
          readOnly: true,
          topic: "규칙을 확인한 뒤 인증 버튼을 눌러 입장하세요.",
        },
      ],
    },
    {
      key: "community",
      name: "커뮤니티",
      audience: "user",
      channels: [
        { key: "general", name: "일반", type: "text", readOnly: false },
        { key: "questions", name: "질문", type: "text", readOnly: false },
        { key: "resources", name: "자료-공유", type: "text", readOnly: false },
      ],
    },
    {
      key: "rapi",
      name: "라피",
      audience: "user",
      channels: [
        {
          key: "rapi_questions",
          name: "라피-질문",
          type: "text",
          readOnly: false,
        },
        {
          key: "rapi_briefing",
          name: "라피-브리핑",
          type: "text",
          readOnly: false,
        },
        { key: "rapi_help", name: "라피-도움말", type: "text", readOnly: true },
      ],
    },
    {
      key: "development",
      name: "개발",
      audience: "user",
      channels: [
        {
          key: "rapi_development",
          name: "라피-개발",
          type: "text",
          readOnly: false,
        },
        {
          key: "github_feed",
          name: "github-피드",
          type: "text",
          readOnly: true,
        },
        {
          key: "technical_rss",
          name: "기술-rss",
          type: "text",
          readOnly: true,
        },
      ],
    },
    {
      key: "operations",
      name: "운영",
      audience: "staff",
      channels: [
        { key: "rapi_admin", name: "라피-관리", type: "text", readOnly: false },
        {
          key: "operations_alerts",
          name: "운영-알림",
          type: "text",
          readOnly: true,
        },
        {
          key: "webhook_admin",
          name: "웹훅-관리",
          type: "text",
          readOnly: false,
        },
        { key: "audit_log", name: "감사-로그", type: "text", readOnly: true },
      ],
    },
    {
      key: "voice",
      name: "음성",
      audience: "user",
      channels: [
        { key: "lounge", name: "라운지", type: "voice", readOnly: false },
        { key: "study_1", name: "공부방-1", type: "voice", readOnly: false },
        { key: "study_2", name: "공부방-2", type: "voice", readOnly: false },
      ],
    },
  ],
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      throw new Error(`Duplicate Discord layout ${label}: ${value}`);
    seen.add(value);
  }
}

export function parseDiscordLayout(input: string): DiscordLayout {
  const raw: unknown = input.trimStart().startsWith("{")
    ? (JSON.parse(input) as unknown)
    : parseYaml(input);
  const parsed = layoutSchema.parse(raw);
  assertUnique(
    parsed.roles.map((role) => role.key),
    "role key",
  );
  assertUnique(
    parsed.roles.map((role) => role.name),
    "role name",
  );
  assertUnique(
    parsed.categories.map((category) => category.name),
    "category name",
  );
  assertUnique(
    parsed.categories.flatMap((category) =>
      category.channels.map((channel) => channel.name),
    ),
    "channel name",
  );
  assertUnique(
    [
      ...parsed.categories.map((category) => category.key),
      ...parsed.categories.flatMap((category) =>
        category.channels.map((channel) => channel.key),
      ),
    ],
    "resource key",
  );
  return parsed;
}

export function serializeDiscordLayout(
  layout: DiscordLayout,
  format: "yaml" | "json",
): string {
  return format === "json"
    ? `${JSON.stringify(layout, null, 2)}\n`
    : stringifyYaml(layout, { lineWidth: 100 });
}

export interface DiscordGuildSnapshot {
  guildId: string;
  roles: Array<{
    id: string;
    name: string;
    permissions: string;
    position: number;
    managed?: boolean;
  }>;
  channels: Array<{
    id: string;
    name: string;
    type: number;
    position: number;
    parentId?: string | null;
    topic?: string | null;
  }>;
}

export interface ManagedDiscordResource {
  resourceType: "role" | "category" | "channel" | "message" | "webhook";
  key: string;
  id: string;
}

export type DiscordLayoutAction =
  | { kind: "create_role"; key: string }
  | { kind: "update_role"; key: string; id: string }
  | { kind: "create_category"; key: string }
  | { kind: "update_category"; key: string; id: string }
  | { kind: "create_channel"; key: string; parentKey: string }
  | { kind: "update_channel"; key: string; id: string; parentKey: string }
  | { kind: "delete_channel"; id: string; name: string };

function rolePermissionBits(
  permissions: DiscordLayout["roles"][number]["permissions"],
): string {
  return permissions.includes("ADMINISTRATOR") ? (1n << 3n).toString() : "0";
}

export function planDiscordLayout(
  layout: DiscordLayout,
  snapshot: DiscordGuildSnapshot,
  managed: ManagedDiscordResource[],
): {
  layoutDigest: string;
  snapshotDigest: string;
  actions: DiscordLayoutAction[];
  adopted: ManagedDiscordResource[];
} {
  const actions: DiscordLayoutAction[] = [];
  const adopted: ManagedDiscordResource[] = [];
  const mappings = new Map(
    managed.map((item) => [`${item.resourceType}:${item.key}`, item.id]),
  );
  const desiredChannelIds = new Set<string>();

  for (const role of layout.roles) {
    const mappedId = mappings.get(`role:${role.key}`);
    const candidates = snapshot.roles.filter((item) =>
      mappedId ? item.id === mappedId : item.name === role.name,
    );
    if (candidates.length > 1)
      throw new Error(`Ambiguous Discord role adoption: ${role.name}`);
    const current = candidates[0];
    if (!current) actions.push({ kind: "create_role", key: role.key });
    else {
      adopted.push({ resourceType: "role", key: role.key, id: current.id });
      if (
        current.name !== role.name ||
        current.permissions !== rolePermissionBits(role.permissions)
      )
        actions.push({ kind: "update_role", key: role.key, id: current.id });
    }
  }

  const categoryIds = new Map<string, string>();
  for (const [categoryPosition, category] of layout.categories.entries()) {
    const mappedId = mappings.get(`category:${category.key}`);
    const candidates = snapshot.channels.filter(
      (item) =>
        item.type === 4 &&
        (mappedId ? item.id === mappedId : item.name === category.name),
    );
    if (candidates.length > 1)
      throw new Error(`Ambiguous Discord category adoption: ${category.name}`);
    const current = candidates[0];
    if (!current) actions.push({ kind: "create_category", key: category.key });
    else {
      categoryIds.set(category.key, current.id);
      desiredChannelIds.add(current.id);
      adopted.push({
        resourceType: "category",
        key: category.key,
        id: current.id,
      });
      if (
        current.name !== category.name ||
        current.position !== categoryPosition
      )
        actions.push({
          kind: "update_category",
          key: category.key,
          id: current.id,
        });
    }
  }

  for (const category of layout.categories) {
    const parentId = categoryIds.get(category.key);
    for (const [channelPosition, channel] of category.channels.entries()) {
      const type = channel.type === "text" ? 0 : 2;
      const mappedId = mappings.get(`channel:${channel.key}`);
      const candidates = snapshot.channels.filter((item) => {
        if (item.type !== type) return false;
        if (mappedId) return item.id === mappedId;
        return (
          item.name === channel.name &&
          (!parentId || item.parentId === parentId)
        );
      });
      if (candidates.length > 1)
        throw new Error(`Ambiguous Discord channel adoption: ${channel.name}`);
      const current = candidates[0];
      if (!current)
        actions.push({
          kind: "create_channel",
          key: channel.key,
          parentKey: category.key,
        });
      else {
        desiredChannelIds.add(current.id);
        adopted.push({
          resourceType: "channel",
          key: channel.key,
          id: current.id,
        });
        if (
          current.name !== channel.name ||
          current.position !== channelPosition ||
          (parentId !== undefined && current.parentId !== parentId) ||
          (channel.type === "text" &&
            (current.topic ?? undefined) !== channel.topic)
        )
          actions.push({
            kind: "update_channel",
            key: channel.key,
            id: current.id,
            parentKey: category.key,
          });
      }
    }
  }

  if (layout.replaceExistingChannels)
    for (const channel of snapshot.channels)
      if (!desiredChannelIds.has(channel.id))
        actions.push({
          kind: "delete_channel",
          id: channel.id,
          name: channel.name,
        });

  return {
    layoutDigest: digest(layout),
    snapshotDigest: digest(snapshot),
    actions,
    adopted,
  };
}
