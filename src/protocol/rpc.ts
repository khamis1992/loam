import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listTasks, getTask, createTask, updateProject, deleteProjectR, listProjects, getProject, createProject, type Task } from "../server/db.js";
import { log } from "../log.js";
import type { ProtocolStore } from "./store.js";
import { shortUid } from "./events.js";

export interface RpcContext {
  userUid: string | null;
  isPublic: boolean;
}

export interface RpcError extends Error {
  code: string;
}

export function rpcError(message: string, code: string): RpcError {
  const e = new Error(message) as RpcError;
  e.code = code;
  return e;
}

const DEMO_USER = {
  user_id: "u_1",
  uid: "u_1",
  email: "demo@example.com",
  firstname: "Demo",
  lastname: "User",
  displayname: "Demo User",
  nickname: "demo",
  avatar: "",
  concurrent_sessions: 1,
  membership_version: "pro",
};

const tokens = new Map<string, string>(); // sessionToken -> userUid
const tempCodes = new Set<string>();
const loginTokens = new Map<string, string>(); // deep-link loginToken -> nonce

function getDataDir(): string {
  const dir = process.env.LOAM_DATA_DIR || process.env.MANUS_LOCAL_DATA_DIR;
  if (dir) return path.resolve(dir);
  return path.resolve("data");
}

const TOKEN_FILE = path.join(getDataDir(), "protocol-tokens.json");

function loadTokens(): void {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return;
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [t, u] of Object.entries(parsed)) {
        if (typeof u === "string") tokens.set(t, u);
      }
      log.info(`protocol loaded ${tokens.size} persisted session token(s)`);
    }
  } catch (err) {
    log.warn(`protocol token load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveTokens(): void {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    const obj = Object.fromEntries(tokens);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    log.warn(`protocol token save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

loadTokens();

function taskStatusToProto(status: Task["status"]): string {
  switch (status) {
    case "queued":
      return "SESSION_STATUS_IN_QUEUE";
    case "running":
      return "SESSION_STATUS_RUNNING";
    case "done":
      return "SESSION_STATUS_STOPPED";
    case "error":
      return "SESSION_STATUS_ERROR";
    case "interrupted":
    case "cancelled":
      return "SESSION_STATUS_STOPPED";
    default:
      return "SESSION_STATUS_CREATED";
  }
}

function loamTaskToAgentSession(task: Task, store: ProtocolStore): Record<string, unknown> {
  const proto = store.getSessionByTaskId(task.id) ?? store.getSession(task.id);
  const deleted = store.isDeleted(task.id);
  return {
    uid: proto?.sessionId ?? task.id,
    user_id: DEMO_USER.user_id,
    title: proto?.title ?? task.title,
    icon: "",
    last_message_time: proto?.updatedAt ? new Date(proto.updatedAt).toISOString() : task.updatedAt,
    last_display_message: task.messages.at(-1)?.content ?? task.prompt,
    last_read_at: task.updatedAt,
    status: deleted ? "SESSION_STATUS_DELETED" : taskStatusToProto(task.status),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    unread_message_count: 0,
    is_favorite: false,
    is_shared: false,
    agent_task_mode: "AGENT_TASK_MODE_STANDARD",
    costed_credits: 0,
    ...(task.projectId ? { project_uid: task.projectId } : {}),
    is_archived: false,
    pined: false,
    desktop_folder_path: "",
    has_running_background_jobs: false,
    is_followed: false,
  };
}

function requireAuth(ctx: RpcContext): string {
  if (!ctx.userUid) throw rpcError("login required", "unauthenticated");
  return ctx.userUid;
}

function sessionUid(body: Record<string, unknown>): string {
  return String(body.session_uid ?? body.sessionUid ?? "");
}

export function makeRpcHandlers(store: ProtocolStore): Record<string, (body: Record<string, unknown>, ctx: RpcContext) => Record<string, unknown>> {
  return {
    // Auth
    "user.v1.UserAuthService/GenerateTempAuthCode": (_body, ctx) => {
      if (!ctx.isPublic) throw rpcError("unauthorized", "unauthenticated");
      const c = randomUUID();
      tempCodes.add(c);
      return { token: c };
    },
    "user.v1.UserAuthPublicService/ExchangeTokenByCode": ({ token }) => {
      if (!tempCodes.delete(String(token))) throw rpcError("invalid code", "unauthenticated");
      const t = randomUUID();
      tokens.set(t, DEMO_USER.uid);
      saveTokens();
      return { token: t };
    },
    "user.v1.UserAuthService/EnsureDeviceIdentity": ({ deviceId, deviceCredential }) => {
      return {
        status: "DEVICE_IDENTITY_STATUS_VERIFIED",
        deviceId: String(deviceId ?? ""),
        deviceCredential: String(deviceCredential ?? randomUUID()),
      };
    },
    "user.v1.UserService/UserInfo": (_body, ctx) => {
      requireAuth(ctx);
      return DEMO_USER;
    },
    "user.v1.UserService/GetAvailableCredits": (_body, ctx) => {
      requireAuth(ctx);
      return { total_credits: 1000, free_credits: 300, periodic_credits: 300, addon_credits: 0, refresh_credits: 300, max_refresh_credits: 300 };
    },
    "user.v1.UserAuthService/Logout": (_body, ctx) => {
      const uid = requireAuth(ctx);
      let changed = false;
      for (const [t, u] of tokens) if (u === uid) { tokens.delete(t); changed = true; }
      if (changed) saveTokens();
      return {};
    },

    // Sessions
    "session.v1.SessionService/ListSessions": ({ limit = 50, offset = 0, is_favorite, project_uid, is_archived }, ctx) => {
      requireAuth(ctx);
      let all = listTasks()
        .filter((t) => !store.isDeleted(t.id))
        .map((t) => loamTaskToAgentSession(t, store));
      if (is_favorite === true) all = all.filter((s) => s.is_favorite);
      if (is_favorite === false) all = all.filter((s) => !s.is_favorite);
      if (typeof project_uid === "string") all = all.filter((s) => s.project_uid === project_uid);
      if (is_archived === true) all = all.filter((s) => s.is_archived);
      if (is_archived === false) all = all.filter((s) => !s.is_archived);
      const start = Number(offset);
      const end = start + Number(limit);
      return { sessions: all.slice(start, end), has_next: end < all.length, total: String(all.length), next_cursor: "" };
    },
    "session.v1.SessionService/GetSession": (body, ctx) => {
      requireAuth(ctx);
      const id = sessionUid(body);
      let session = store.getSession(id);
      let task = session?.taskId ? getTask(session.taskId) : undefined;
      if (!task) task = getTask(id);
      if (!task) throw rpcError("not found", "not_found");
      if (!session) {
        session = store.ensureSession(id, task.id, task.title);
      } else if (!session.taskId) {
        store.setTaskId(id, task.id);
      }
      return { session: loamTaskToAgentSession(task, store) };
    },
    "session.v1.SessionService/UpdateSession": (body, ctx) => {
      requireAuth(ctx);
      const id = sessionUid(body);
      const session = store.getSession(id) ?? store.getSessionByTaskId(id);
      const task = session?.taskId ? getTask(session.taskId) : getTask(id);
      if (!task && !session) throw rpcError("not found", "not_found");
      const { title, icon, status } = body;
      if (typeof title === "string" && title.trim()) {
        const trimmed = title.trim().slice(0, 80);
        if (session) store.setTitle(session.sessionId, trimmed);
        else if (task) {
          // Ensure a protocol session exists to hold the title override.
          const sid = store.ensureSession(task.id, task.id, task.title).sessionId;
          store.setTitle(sid, trimmed);
        }
      }
      // Loam Task has no icon/status fields; status is driven by the run.
      void icon;
      void status;
      return {};
    },
    "session.v1.SessionService/DeleteSession": (body, ctx) => {
      requireAuth(ctx);
      const id = sessionUid(body);
      const session = store.getSession(id) ?? store.getSessionByTaskId(id);
      const task = session?.taskId ? getTask(session.taskId) : getTask(id);
      const taskId = session?.taskId ?? task?.id;
      if (taskId) {
        store.deleteTask(taskId);
        log.info(`protocol delete session ${id} -> task ${taskId} (soft-deleted in protocol store)`);
      } else {
        log.info(`protocol delete session ${id} (no matching task)`);
      }
      return {};
    },
    "session.v1.SessionService/FavoriteSession": (body, ctx) => {
      requireAuth(ctx);
      const task = getTask(sessionUid(body));
      if (!task) throw rpcError("not found", "not_found");
      // No favorite field on Loam Task; stub.
      return {};
    },
    "session.v1.SessionService/UnFavoriteSession": (body, ctx) => {
      requireAuth(ctx);
      void sessionUid(body);
      return {};
    },
    "session.v1.SessionService/ArchiveSession": (body, ctx) => {
      requireAuth(ctx);
      void sessionUid(body);
      return {};
    },
    "session.v1.SessionService/UnarchiveSession": (body, ctx) => {
      requireAuth(ctx);
      void sessionUid(body);
      return {};
    },
    "session.v1.SessionService/UpdateReadPosition": ({ last_read_at }, ctx) => {
      requireAuth(ctx);
      void last_read_at;
      return {};
    },
    "session.v1.SessionService/ListSessionFiles": ({ session_id, limit = 50, offset = 0 }, ctx) => {
      requireAuth(ctx);
      void session_id;
      return { files: [], total: "0" };
    },

    // Projects
    "session.v1.ProjectService/ListProjects": (_body, ctx) => {
      requireAuth(ctx);
      const projects = listProjects().map((p) => ({
        uid: p.id,
        name: p.name,
        description: p.instruction ?? "",
        logo: "",
        instruction: p.instruction ?? "",
        sessions: [],
        session_count: 0,
        is_pinned: false,
        is_favorite: false,
        last_activity_at: p.updatedAt,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      }));
      return { projects };
    },
    "session.v1.ProjectService/CreateProject": ({ name, instruction }, ctx) => {
      requireAuth(ctx);
      const p = createProject(String(name ?? "New project"), typeof instruction === "string" ? instruction : undefined);
      return {
        uid: p.id,
        name: p.name,
        description: p.instruction ?? "",
        instruction: p.instruction ?? "",
        sessions: [],
        session_count: 0,
        is_pinned: false,
        is_favorite: false,
        last_activity_at: p.updatedAt,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      };
    },
    "session.v1.ProjectService/UpdateProject": ({ project_uid, name, instruction }, ctx) => {
      requireAuth(ctx);
      const p = updateProject(String(project_uid ?? ""), { name: typeof name === "string" ? name : undefined, instruction: typeof instruction === "string" ? instruction : undefined });
      if (!p) throw rpcError("not found", "not_found");
      return {
        uid: p.id,
        name: p.name,
        description: p.instruction ?? "",
        instruction: p.instruction ?? "",
        sessions: [],
        session_count: 0,
        is_pinned: false,
        is_favorite: false,
        last_activity_at: p.updatedAt,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      };
    },
    "session.v1.ProjectService/DeleteProject": ({ project_uid }, ctx) => {
      requireAuth(ctx);
      const ok = deleteProjectR(String(project_uid ?? ""));
      if (!ok) throw rpcError("not found", "not_found");
      return {};
    },

    // Desktop
    "desktop.v1.DesktopService/GetDesktopDevices": (_body, ctx) => {
      requireAuth(ctx);
      return { devices: [] };
    },
  };
}

export function tokenToUserUid(token: string | undefined): string | null {
  if (!token) return null;
  return tokens.get(token) ?? null;
}

export function consumeLoginToken(token: string): string | undefined {
  return loginTokens.get(token);
}

export function issueLoginToken(nonce: string): string {
  const token = randomUUID();
  loginTokens.set(token, nonce);
  return token;
}
