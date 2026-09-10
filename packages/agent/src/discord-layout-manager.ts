import { readFile } from "node:fs/promises";
import type { PostgresStore } from "@rapi/db";
import {
  parseDiscordLayout,
  planDiscordLayout,
  serializeDiscordLayout,
  type DiscordGuildSnapshot,
  type DiscordLayout,
  type DiscordLayoutAction,
  type ManagedDiscordResource,
} from "./discord-layout.js";

export interface DiscordRest {
  request<T>(route: string, init?: RequestInit): Promise<T>;
}

export class DiscordRestClient implements DiscordRest {
  constructor(
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bot ${this.token}`);
      if (init.body) headers.set("content-type", "application/json");
      const response = await this.fetcher(
        `https://discord.com/api/v10${route}`,
        {
          ...init,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      const error = (await response.json().catch(() => ({}))) as {
        message?: string;
        retry_after?: number;
      };
      if (response.status === 429 && attempt < 4) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(30_000, Math.max(1_000, (error.retry_after ?? 1) * 1_000)),
          ),
        );
        continue;
      }
      throw new Error(
        `Discord API ${response.status}${error.message ? `: ${error.message}` : ""}`,
      );
    }
    throw new Error("Discord API retry budget exhausted");
  }
}

type DiscordRole = {
  id: string;
  name: string;
  permissions: string;
  position: number;
  managed?: boolean;
};

type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id?: string | null;
  topic?: string | null;
};

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_HISTORY = 1n << 16n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;

function permissions(role: DiscordLayout["roles"][number]): string {
  return role.permissions.includes("ADMINISTRATOR")
    ? (1n << 3n).toString()
    : "0";
}

function resourceKey(type: string, key: string): string {
  return `${type}:${key}`;
}

function actionSummary(actions: DiscordLayoutAction[]): string {
  const counts = new Map<string, number>();
  for (const action of actions)
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  const labels: Record<string, string> = {
    create_role: "역할 생성",
    update_role: "역할 수정",
    create_category: "카테고리 생성",
    update_category: "카테고리 수정",
    create_channel: "채널 생성",
    update_channel: "채널 수정",
    delete_channel: "채널 삭제",
  };
  return [...counts]
    .map(([kind, count]) => `${labels[kind] ?? kind} ${count}`)
    .join(" · ");
}

export class DiscordLayoutManager {
  readonly rest: DiscordRest;

  constructor(
    readonly store: PostgresStore,
    readonly options: {
      botToken: string;
      layoutFile: string;
      rest?: DiscordRest;
      now?: () => Date;
    },
  ) {
    this.rest = options.rest ?? new DiscordRestClient(options.botToken);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async loadLayout(): Promise<DiscordLayout> {
    return parseDiscordLayout(await readFile(this.options.layoutFile, "utf8"));
  }

  async snapshot(guildId: string): Promise<DiscordGuildSnapshot> {
    const [roles, channels] = await Promise.all([
      this.rest.request<DiscordRole[]>(`/guilds/${guildId}/roles`),
      this.rest.request<DiscordChannel[]>(`/guilds/${guildId}/channels`),
    ]);
    return {
      guildId,
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        permissions: role.permissions,
        position: role.position,
        ...(role.managed !== undefined ? { managed: role.managed } : {}),
      })),
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        position: channel.position,
        ...(channel.parent_id !== undefined
          ? { parentId: channel.parent_id }
          : {}),
        ...(channel.topic !== undefined ? { topic: channel.topic } : {}),
      })),
    };
  }

  private async managed(guildId: string): Promise<ManagedDiscordResource[]> {
    return (await this.store.listManagedDiscordResources(guildId)).map(
      (item) => ({
        resourceType: item.resourceType,
        key: item.key,
        id: item.discordId,
      }),
    );
  }

  async preview(
    guildId: string,
    actorId: string,
  ): Promise<{ summary: string; planId: string }> {
    const [layout, snapshot, managed] = await Promise.all([
      this.loadLayout(),
      this.snapshot(guildId),
      this.managed(guildId),
    ]);
    await this.assertBotAdministrator(guildId, snapshot.roles);
    const plan = planDiscordLayout(layout, snapshot, managed);
    const planId = await this.store.createDiscordLayoutPlan({
      guildId,
      createdBy: actorId,
      layoutDigest: plan.layoutDigest,
      snapshotDigest: plan.snapshotDigest,
      payload: { actions: plan.actions, adopted: plan.adopted },
      expiresAt: new Date(this.now().getTime() + 10 * 60_000),
    });
    const deletions = plan.actions
      .filter((action) => action.kind === "delete_channel")
      .map((action) => action.name);
    return {
      planId,
      summary: [
        `서버 구성 계획 ${planId}`,
        actionSummary(plan.actions) || "구조 변경 없음",
        `권한 동기화 ${layout.categories.length + layout.categories.flatMap((item) => item.channels).length}개`,
        deletions.length
          ? `삭제 대상: ${deletions.join(", ")}`
          : "삭제 대상 없음",
        "10분 이내 아래 적용 버튼을 눌러야 하며 서버 상태가 바뀌면 계획은 무효화됩니다.",
      ].join("\n"),
    };
  }

  private async assertBotAdministrator(
    guildId: string,
    roles: DiscordRole[],
  ): Promise<void> {
    const member = await this.rest.request<{ roles: string[] }>(
      `/guilds/${guildId}/members/@me`,
    );
    let value = BigInt(
      roles.find((role) => role.id === guildId)?.permissions ?? "0",
    );
    for (const id of member.roles)
      value |= BigInt(roles.find((role) => role.id === id)?.permissions ?? "0");
    if ((value & (1n << 3n)) === 0n)
      throw new Error(
        "라피 봇 역할에 Discord Administrator 권한이 필요합니다.",
      );
    const botTop = Math.max(
      0,
      ...member.roles.map(
        (id) => roles.find((role) => role.id === id)?.position ?? 0,
      ),
    );
    const staff = roles.find((role) => role.name === "라피 운영진");
    if (staff && !member.roles.includes(staff.id) && staff.position >= botTop)
      throw new Error(
        "라피 봇 역할을 `라피 운영진` 역할보다 위에 배치해야 합니다.",
      );
  }

  private permissionOverwrites(
    guildId: string,
    audience: "everyone" | "user" | "staff",
    roleIds: Map<string, string>,
    channel?: { type: "text" | "voice"; readOnly: boolean },
  ): Array<{ id: string; type: 0; allow: string; deny: string }> {
    const userId = roleIds.get("rapi_user");
    const staffId = roleIds.get("rapi_staff");
    if (!userId || !staffId)
      throw new Error("Managed Discord roles are missing");
    const useVoice = channel?.type === "voice";
    const baseAllow =
      VIEW_CHANNEL | READ_HISTORY | (useVoice ? CONNECT | SPEAK : 0n);
    const denySend =
      channel?.type === "text" && channel.readOnly ? SEND_MESSAGES : 0n;
    const everyoneAllow = audience === "everyone" ? baseAllow : 0n;
    const everyoneDeny =
      (audience === "everyone" ? 0n : VIEW_CHANNEL) | denySend;
    const userAllow = audience === "user" ? baseAllow : 0n;
    const userDeny = (audience === "staff" ? VIEW_CHANNEL : 0n) | denySend;
    return [
      {
        id: guildId,
        type: 0,
        allow: everyoneAllow.toString(),
        deny: everyoneDeny.toString(),
      },
      {
        id: userId,
        type: 0,
        allow: userAllow.toString(),
        deny: userDeny.toString(),
      },
      {
        id: staffId,
        type: 0,
        allow: (baseAllow | SEND_MESSAGES).toString(),
        deny: "0",
      },
    ];
  }

  async apply(
    guildId: string,
    actorId: string,
    planId: string,
  ): Promise<string> {
    const saved = await this.store.discordLayoutPlan(guildId, planId);
    if (!saved || saved.appliedAt || saved.expiresAt <= this.now())
      throw new Error(
        "서버 구성 계획이 없거나 만료됐습니다. 미리보기를 다시 실행하세요.",
      );
    if (!(await this.store.claimDiscordLayoutPlan(guildId, planId)))
      throw new Error("서버 구성 계획이 이미 적용 중이거나 사용됐습니다.");
    try {
      const [layout, snapshot, managed] = await Promise.all([
        this.loadLayout(),
        this.snapshot(guildId),
        this.managed(guildId),
      ]);
      await this.assertBotAdministrator(guildId, snapshot.roles);
      const fresh = planDiscordLayout(layout, snapshot, managed);
      if (
        fresh.layoutDigest !== saved.layoutDigest ||
        fresh.snapshotDigest !== saved.snapshotDigest
      )
        throw new Error(
          "구성 파일 또는 Discord 서버가 변경됐습니다. 미리보기를 다시 실행하세요.",
        );

      const ids = new Map<string, string>();
      for (const item of fresh.adopted) {
        ids.set(resourceKey(item.resourceType, item.key), item.id);
        await this.store.upsertManagedDiscordResource({
          guildId,
          resourceType: item.resourceType,
          key: item.key,
          discordId: item.id,
          layoutDigest: fresh.layoutDigest,
        });
      }
      const roleByKey = new Map(layout.roles.map((role) => [role.key, role]));
      const categoryByKey = new Map(
        layout.categories.map((category) => [category.key, category]),
      );
      const categoryPositionByKey = new Map(
        layout.categories.map((category, index) => [category.key, index]),
      );
      const channelByKey = new Map(
        layout.categories.flatMap((category) =>
          category.channels.map(
            (channel, position) =>
              [
                channel.key,
                { ...channel, parentKey: category.key, position },
              ] as const,
          ),
        ),
      );

      for (const action of fresh.actions.filter(
        (item) => item.kind === "create_role" || item.kind === "update_role",
      )) {
        const role = roleByKey.get(action.key)!;
        const body = JSON.stringify({
          name: role.name,
          permissions: permissions(role),
          color: role.color,
          hoist: role.hoist,
          mentionable: false,
        });
        const current =
          action.kind === "create_role"
            ? await this.rest.request<{ id: string }>(
                `/guilds/${guildId}/roles`,
                {
                  method: "POST",
                  body,
                },
              )
            : await this.rest.request<{ id: string }>(
                `/guilds/${guildId}/roles/${action.id}`,
                { method: "PATCH", body },
              );
        ids.set(resourceKey("role", action.key), current.id);
        await this.store.upsertManagedDiscordResource({
          guildId,
          resourceType: "role",
          key: action.key,
          discordId: current.id,
          layoutDigest: fresh.layoutDigest,
        });
      }

      for (const action of fresh.actions.filter(
        (item) =>
          item.kind === "create_category" || item.kind === "update_category",
      )) {
        const category = categoryByKey.get(action.key)!;
        const body = JSON.stringify({
          name: category.name,
          type: 4,
          position: categoryPositionByKey.get(category.key),
        });
        const current =
          action.kind === "create_category"
            ? await this.rest.request<{ id: string }>(
                `/guilds/${guildId}/channels`,
                {
                  method: "POST",
                  body,
                },
              )
            : await this.rest.request<{ id: string }>(
                `/channels/${action.id}`,
                {
                  method: "PATCH",
                  body,
                },
              );
        ids.set(resourceKey("category", action.key), current.id);
        await this.store.upsertManagedDiscordResource({
          guildId,
          resourceType: "category",
          key: action.key,
          discordId: current.id,
          layoutDigest: fresh.layoutDigest,
        });
      }

      for (const action of fresh.actions.filter(
        (item) =>
          item.kind === "create_channel" || item.kind === "update_channel",
      )) {
        const channel = channelByKey.get(action.key)!;
        const parentId = ids.get(resourceKey("category", channel.parentKey));
        if (!parentId)
          throw new Error(`Discord category missing: ${channel.parentKey}`);
        const body = JSON.stringify({
          name: channel.name,
          type: channel.type === "text" ? 0 : 2,
          parent_id: parentId,
          position: channel.position,
          ...(channel.topic ? { topic: channel.topic } : {}),
        });
        const current =
          action.kind === "create_channel"
            ? await this.rest.request<{ id: string }>(
                `/guilds/${guildId}/channels`,
                {
                  method: "POST",
                  body,
                },
              )
            : await this.rest.request<{ id: string }>(
                `/channels/${action.id}`,
                {
                  method: "PATCH",
                  body,
                },
              );
        ids.set(resourceKey("channel", action.key), current.id);
        await this.store.upsertManagedDiscordResource({
          guildId,
          resourceType: "channel",
          key: action.key,
          discordId: current.id,
          layoutDigest: fresh.layoutDigest,
        });
      }

      const roleIds = new Map(
        layout.roles.map((role) => [
          role.key,
          ids.get(resourceKey("role", role.key))!,
        ]),
      );
      for (const category of layout.categories) {
        const categoryId = ids.get(resourceKey("category", category.key));
        if (!categoryId)
          throw new Error(`Discord category missing: ${category.key}`);
        await this.rest.request(`/channels/${categoryId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: category.name,
            position: categoryPositionByKey.get(category.key),
            permission_overwrites: this.permissionOverwrites(
              guildId,
              category.audience,
              roleIds,
            ),
          }),
        });
        for (const channel of category.channels) {
          const channelId = ids.get(resourceKey("channel", channel.key));
          if (!channelId)
            throw new Error(`Discord channel missing: ${channel.key}`);
          await this.rest.request(`/channels/${channelId}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: channel.name,
              parent_id: categoryId,
              position: category.channels.indexOf(channel),
              ...(channel.topic ? { topic: channel.topic } : {}),
              permission_overwrites: this.permissionOverwrites(
                guildId,
                category.audience,
                roleIds,
                channel,
              ),
            }),
          });
        }
      }

      const deletions = fresh.actions
        .filter((action) => action.kind === "delete_channel")
        .sort((left, right) => {
          const leftType = snapshot.channels.find(
            (item) => item.id === left.id,
          )?.type;
          const rightType = snapshot.channels.find(
            (item) => item.id === right.id,
          )?.type;
          return Number(leftType === 4) - Number(rightType === 4);
        });
      for (const action of deletions) {
        await this.rest.request(`/channels/${action.id}`, { method: "DELETE" });
        await this.store.removeManagedDiscordResource(
          guildId,
          "channel",
          action.id,
        );
        await this.store.removeManagedDiscordResource(
          guildId,
          "category",
          action.id,
        );
      }

      await this.ensureVerificationMessage(guildId, ids, fresh.layoutDigest);
      for (const key of ["rapi_questions", "rapi_admin"]) {
        const id = ids.get(resourceKey("channel", key));
        if (id) await this.store.enableChatChannel(guildId, id, actorId);
      }
      if (!(await this.store.markDiscordLayoutPlanApplied(guildId, planId)))
        throw new Error("서버 구성 계획 완료 상태를 기록하지 못했습니다.");
      return `서버 구성을 적용했습니다: ${actionSummary(fresh.actions) || "권한 동기화"}`;
    } catch (error) {
      await this.store.releaseDiscordLayoutPlanClaim(guildId, planId);
      throw error;
    }
  }

  private async ensureVerificationMessage(
    guildId: string,
    ids: Map<string, string>,
    layoutDigest: string,
  ): Promise<void> {
    const channelId = ids.get(resourceKey("channel", "roles"));
    if (!channelId) throw new Error("Verification channel is missing");
    const body = JSON.stringify({
      content:
        "규칙을 확인했다면 아래 버튼을 눌러 `라피 USER` 역할을 받고 입장하세요.",
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "인증하고 입장",
              custom_id: "rapi_verify:v1",
            },
          ],
        },
      ],
    });
    const existing = await this.store.managedDiscordResourceId(
      guildId,
      "message",
      "verification",
    );
    let message: { id: string };
    if (existing) {
      try {
        message = await this.rest.request<{ id: string }>(
          `/channels/${channelId}/messages/${existing}`,
          { method: "PATCH", body },
        );
      } catch {
        message = await this.rest.request<{ id: string }>(
          `/channels/${channelId}/messages`,
          { method: "POST", body },
        );
      }
    } else {
      message = await this.rest.request<{ id: string }>(
        `/channels/${channelId}/messages`,
        { method: "POST", body },
      );
    }
    await this.store.upsertManagedDiscordResource({
      guildId,
      resourceType: "message",
      key: "verification",
      discordId: message.id,
      layoutDigest,
    });
  }

  async verifyMember(guildId: string, userId: string): Promise<string> {
    const roleId = await this.store.managedDiscordResourceId(
      guildId,
      "role",
      "rapi_user",
    );
    if (!roleId) throw new Error("라피 USER 역할이 아직 준비되지 않았습니다.");
    await this.rest.request(
      `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      {
        method: "PUT",
      },
    );
    return "인증이 완료됐습니다. `라피 USER` 역할을 부여했습니다.";
  }

  async export(format: "yaml" | "json"): Promise<string> {
    return serializeDiscordLayout(await this.loadLayout(), format);
  }

  async channelId(guildId: string, key: string): Promise<string> {
    const id = await this.store.managedDiscordResourceId(
      guildId,
      "channel",
      key,
    );
    if (!id) throw new Error(`Managed Discord channel missing: ${key}`);
    return id;
  }

  async createWebhook(
    guildId: string,
    channelKey: string,
    name: string,
  ): Promise<string> {
    const channelId = await this.channelId(guildId, channelKey);
    const webhook = await this.rest.request<{ id: string; token: string }>(
      `/channels/${channelId}/webhooks`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
    if (!webhook.id || !webhook.token)
      throw new Error("Discord did not return a webhook token");
    return `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
  }
}
