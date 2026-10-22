type JsonRecord = Record<string, unknown>;

type PublicError = { code: string; message: string };

type Capability = {
  name: string;
  description?: string;
  inputSchema: JsonRecord;
  outputSchema: JsonRecord;
};

type PluginManifest = {
  id: string;
  name: string;
  description?: string;
  version: string;
  protocolVersion: string;
  entry: string;
  capabilities: Capability[];
  configSchema: JsonRecord;
  permissions: string[];
};

type PluginRecord = {
  manifest: PluginManifest;
  enabled: boolean;
  config: JsonRecord;
  grants: { readRoots: string[] };
  installedAt: string;
  packagePath: string;
};

type ExecutionResult = {
  executionId: string;
  pluginId: string;
  capability: string;
  ok: boolean;
  durationMs: number;
  runtime?: { pid: number; terminated: boolean };
  data?: unknown;
  error?: PublicError;
};

type Session = { token: string; dataDir: string; protocolVersion: string };
type Tone = "neutral" | "working" | "success" | "error";

const state: {
  token: string | null;
  plugins: PluginRecord[];
  selectedId: string | null;
  selectionRequest: number;
  execution: ExecutionResult | null;
} = {
  token: null,
  plugins: [],
  selectedId: null,
  selectionRequest: 0,
  execution: null,
};

const detailPanel = requiredElement<HTMLElement>("detail-panel");
const pluginList = requiredElement<HTMLElement>("plugin-list");
const statusMessage = requiredElement<HTMLParagraphElement>("status-message");
const connectionNote = requiredElement<HTMLParagraphElement>("connection-note");
const installForm = requiredElement<HTMLFormElement>("install-form");
const refreshButton = requiredElement<HTMLButtonElement>("refresh-plugins");

class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

class InputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required page element: ${id}`);
  }
  return element as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function setStatus(message: string, tone: Tone = "neutral"): void {
  statusMessage.textContent = message;
  if (tone === "neutral") {
    delete statusMessage.dataset.tone;
  } else {
    statusMessage.dataset.tone = tone;
  }
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function clear(element: Element): void {
  element.replaceChildren();
}

function errorFrom(error: unknown): ApiError | InputError {
  if (error instanceof ApiError || error instanceof InputError) return error;
  if (error instanceof Error) return new ApiError("UNEXPECTED_ERROR", error.message);
  return new ApiError("UNEXPECTED_ERROR", "发生未预期的本地错误。");
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readableDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("LOCAL_SERVICE_UNAVAILABLE", "无法连接本地宿主服务。");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("INVALID_RESPONSE", `本地服务返回了无法解析的响应 (${response.status}).`);
  }

  if (isRecord(body) && body.ok === true && Object.prototype.hasOwnProperty.call(body, "data")) {
    return body.data as T;
  }

  if (isRecord(body) && body.ok === false && isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : "REQUEST_FAILED";
    const message = typeof body.error.message === "string" ? body.error.message : "本地服务拒绝了请求。";
    throw new ApiError(code, message);
  }

  throw new ApiError("INVALID_RESPONSE", `本地服务返回了未预期的响应 (${response.status}).`);
}

function writeInit(method: "POST" | "PUT" | "DELETE", data: unknown): RequestInit {
  if (!state.token) {
    throw new ApiError("NO_SESSION", "尚未建立本地会话，请刷新后重试。");
  }
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Harness-Token": state.token,
    },
    body: JSON.stringify(data),
  };
}

function addFormError(form: HTMLFormElement, message: string): void {
  const prior = form.querySelector<HTMLElement>("[data-form-error]");
  if (prior) prior.remove();
  const error = textElement("p", message, "field-error");
  error.dataset.formError = "true";
  error.setAttribute("role", "alert");
  form.append(error);
}

function removeFormError(form: HTMLFormElement): void {
  form.querySelector("[data-form-error]")?.remove();
}

function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyText: string): void {
  if (busy) {
    button.dataset.idleText = button.textContent ?? "";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = busyText;
    return;
  }
  button.disabled = false;
  button.removeAttribute("aria-busy");
  button.textContent = button.dataset.idleText ?? button.textContent;
  delete button.dataset.idleText;
}

function schemaProperties(schema: JsonRecord): Array<[string, JsonRecord]> {
  const properties = asRecord(schema.properties);
  return Object.entries(properties).map(([name, definition]) => [name, asRecord(definition)]);
}

function requiredProperties(schema: JsonRecord): Set<string> {
  return new Set(strings(schema.required));
}

function schemaType(schema: JsonRecord): string {
  return typeof schema.type === "string" ? schema.type : "";
}

function fieldKind(schema: JsonRecord): "enum" | "number" | "boolean" | "json" | "textarea" | "text" {
  if (Array.isArray(schema.enum)) return "enum";
  const type = schemaType(schema);
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "object" || type === "array") return "json";
  const maximumLength = typeof schema.maxLength === "number" ? schema.maxLength : 0;
  if (schema.format === "textarea" || schema.contentMediaType === "text/plain" || maximumLength > 160) return "textarea";
  return "text";
}

function initialValue(values: JsonRecord, property: string, schema: JsonRecord): unknown {
  if (Object.prototype.hasOwnProperty.call(values, property)) return values[property];
  if (Object.prototype.hasOwnProperty.call(schema, "default")) return schema.default;
  return undefined;
}

function createSchemaField(group: string, index: number, property: string, schema: JsonRecord, value: unknown, required: boolean): HTMLElement {
  const field = document.createElement("div");
  field.className = "field";
  const inputId = `${group}-field-${index}`;
  const title = typeof schema.title === "string" ? schema.title : property;
  const label = document.createElement("label");
  label.htmlFor = inputId;
  label.textContent = required ? `${title}（必填）` : title;
  field.append(label);

  const kind = fieldKind(schema);
  let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  if (kind === "enum") {
    const select = document.createElement("select");
    select.id = inputId;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = required ? "请选择" : "未设置";
    placeholder.dataset.json = "";
    select.append(placeholder);
    const current = stringify(value);
    const choices = Array.isArray(schema.enum) ? schema.enum : [];
    choices.forEach((choice) => {
      const option = document.createElement("option");
      option.value = stringify(choice);
      option.dataset.json = option.value;
      option.textContent = typeof choice === "string" ? choice : stringify(choice);
      if (option.value === current) option.selected = true;
      select.append(option);
    });
    control = select;
  } else if (kind === "textarea" || kind === "json") {
    const textarea = document.createElement("textarea");
    textarea.id = inputId;
    textarea.value = kind === "json" && value !== undefined ? stringify(value) : typeof value === "string" ? value : "";
    textarea.className = kind === "json" ? "json-input" : "";
    control = textarea;
  } else {
    const input = document.createElement("input");
    input.id = inputId;
    if (kind === "number") {
      input.type = "number";
      if (schemaType(schema) === "integer") input.step = "1";
      if (typeof schema.minimum === "number") input.min = String(schema.minimum);
      if (typeof schema.maximum === "number") input.max = String(schema.maximum);
      input.value = value === undefined ? "" : String(value);
    } else if (kind === "boolean") {
      input.type = "checkbox";
      input.checked = value === true;
    } else {
      input.type = "text";
      input.value = typeof value === "string" ? value : value === undefined ? "" : String(value);
    }
    control = input;
  }

  control.required = required && (!(kind === "text" || kind === "textarea") || (typeof schema.minLength === "number" && schema.minLength > 0));
  control.dataset.property = property;
  control.dataset.valueKind = kind;
  control.dataset.fieldGroup = group;
  field.append(control);

  if (typeof schema.description === "string") {
    const description = textElement("p", schema.description, "field-description");
    field.append(description);
  }
  return field;
}

function createSchemaFields(group: string, schema: JsonRecord, values: JsonRecord): HTMLElement {
  const wrapper = document.createElement("div");
  const properties = schemaProperties(schema);
  const required = requiredProperties(schema);
  if (properties.length === 0) {
    wrapper.append(textElement("p", "没有单独配置项，可使用下方高级 JSON 编辑器。", "muted"));
    return wrapper;
  }
  properties.forEach(([property, definition], index) => {
    wrapper.append(createSchemaField(group, index, property, definition, initialValue(values, property, definition), required.has(property)));
  });
  return wrapper;
}

function createAdvancedEditor(group: string, label: string, hint: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "advanced-editor";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const copy = textElement("p", hint);
  const textarea = document.createElement("textarea");
  textarea.className = "json-input";
  textarea.dataset.advancedFor = group;
  textarea.setAttribute("aria-label", label);
  textarea.spellcheck = false;
  textarea.placeholder = "{\n  \n}";
  details.append(summary, copy, textarea);
  return details;
}

function readGeneratedValues(form: HTMLFormElement, group: string): JsonRecord {
  const output: JsonRecord = {};
  const controls = form.querySelectorAll<HTMLElement>("[data-property]");
  controls.forEach((element) => {
    if (element.dataset.fieldGroup !== group) return;
    const property = element.dataset.property;
    const kind = element.dataset.valueKind;
    if (!property || !kind) return;

    if (element instanceof HTMLSelectElement && kind === "enum") {
      const option = element.selectedOptions[0];
      if (!option || !option.dataset.json) {
        if (element.required) throw new InputError("INPUT_REQUIRED", `请选择 ${property}。`);
        return;
      }
      try {
        output[property] = JSON.parse(option.dataset.json) as unknown;
      } catch {
        throw new InputError("INVALID_ENUM_VALUE", `${property} 的选项无效。`);
      }
      return;
    }

    if (element instanceof HTMLInputElement && kind === "number") {
      if (!element.value) {
        if (element.required) throw new InputError("INPUT_REQUIRED", `请输入 ${property}。`);
        return;
      }
      const number = Number(element.value);
      if (!Number.isFinite(number)) throw new InputError("INVALID_NUMBER", `${property} 必须为有效数字。`);
      output[property] = number;
      return;
    }

    if (element instanceof HTMLInputElement && kind === "boolean") {
      output[property] = element.checked;
      return;
    }

    if (element instanceof HTMLTextAreaElement && kind === "json") {
      if (!element.value.trim()) {
        if (element.required) throw new InputError("INPUT_REQUIRED", `请输入 ${property} 的 JSON。`);
        return;
      }
      try {
        output[property] = JSON.parse(element.value) as unknown;
      } catch {
        throw new InputError("INVALID_FIELD_JSON", `${property} 的 JSON 无效。`);
      }
      return;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (!element.value && element.required) throw new InputError("INPUT_REQUIRED", `请输入 ${property}。`);
      output[property] = element.value;
    }
  });
  return output;
}

function readInput(form: HTMLFormElement, group: string, requireObject: boolean): unknown {
  const advanced = form.querySelector<HTMLTextAreaElement>(`textarea[data-advanced-for="${group}"]`);
  if (advanced?.value.trim()) {
    try {
      const value = JSON.parse(advanced.value) as unknown;
      if (requireObject && !isRecord(value)) throw new InputError("JSON_OBJECT_REQUIRED", "高级 JSON 必须为对象。");
      return value;
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError("INVALID_ADVANCED_JSON", "高级 JSON 无效，请修正后继续。");
    }
  }
  return readGeneratedValues(form, group);
}

function statusTag(enabled: boolean): HTMLSpanElement {
  const tag = textElement("span", enabled ? "已启用" : "已禁用", `status-tag ${enabled ? "enabled" : "disabled"}`);
  return tag;
}

function updatePlugin(record: PluginRecord): void {
  const index = state.plugins.findIndex((item) => item.manifest.id === record.manifest.id);
  if (index === -1) {
    state.plugins = [record, ...state.plugins];
  } else {
    state.plugins[index] = record;
  }
}

function renderPluginList(): void {
  clear(pluginList);
  if (state.plugins.length === 0) {
    pluginList.append(textElement("p", "尚未安装插件。", "empty-list"));
    return;
  }

  state.plugins.forEach((record) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plugin-item";
    button.setAttribute("aria-current", String(state.selectedId === record.manifest.id));
    button.setAttribute("aria-label", `打开 ${record.manifest.name}`);

    const copy = document.createElement("span");
    const name = textElement("span", record.manifest.name, "plugin-item-name");
    const id = textElement("span", record.manifest.id, "plugin-item-id");
    copy.append(name, id);
    button.append(copy, statusTag(record.enabled));
    button.addEventListener("click", () => {
      void selectPlugin(record.manifest.id);
    });
    pluginList.append(button);
  });
}

function renderLoadingWorkspace(): void {
  clear(detailPanel);
  const panel = document.createElement("div");
  panel.className = "empty-workspace";
  panel.append(textElement("p", "本地工作区", "eyebrow"), textElement("h2", "正在加载插件详情"), textElement("p", "正在读取插件协议及当前配置。", "muted"));
  detailPanel.append(panel);
}

function renderWorkspaceError(error: ApiError | InputError): void {
  clear(detailPanel);
  const panel = document.createElement("div");
  panel.className = "empty-workspace";
  panel.append(textElement("p", "本地工作区", "eyebrow"), textElement("h2", "无法获取插件详情"));
  const message = textElement("p", `${error.code}: ${error.message}`, "error-callout");
  panel.append(message);
  detailPanel.append(panel);
}

function createManifestDetails(record: PluginRecord): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "details-block";
  const summary = document.createElement("summary");
  summary.textContent = "Manifest 与协议详情";
  details.append(summary);

  const definitionList = document.createElement("dl");
  definitionList.className = "manifest-grid";
  const rows: Array<[string, string]> = [
    ["插件 ID", record.manifest.id],
    ["版本", record.manifest.version],
    ["协议", record.manifest.protocolVersion],
    ["入口", record.manifest.entry],
    ["安装时间", readableDate(record.installedAt)],
    ["安装路径", record.packagePath],
    ["声明的权限", record.manifest.permissions.length ? record.manifest.permissions.join(", ") : "无"],
  ];
  rows.forEach(([term, value]) => {
    const dt = textElement("dt", term);
    const dd = document.createElement("dd");
    if (term === "插件 ID" || term === "入口" || term === "安装路径") {
      dd.append(textElement("code", value));
    } else {
      dd.textContent = value;
    }
    definitionList.append(dt, dd);
  });
  details.append(definitionList);

  const capabilities = document.createElement("div");
  capabilities.className = "manifest-capabilities";
  capabilities.append(textElement("h4", "声明的能力"));
  if (record.manifest.capabilities.length === 0) {
    capabilities.append(textElement("p", "未声明能力。", "muted"));
  } else {
    const list = document.createElement("ul");
    record.manifest.capabilities.forEach((capability) => {
      const item = document.createElement("li");
      const name = textElement("code", capability.name);
      item.append(name);
      if (capability.description) item.append(document.createTextNode(` — ${capability.description}`));
      list.append(item);
    });
    capabilities.append(list);
  }
  details.append(capabilities);

  const rawManifest = document.createElement("pre");
  rawManifest.className = "json-output";
  rawManifest.textContent = stringify(record.manifest);
  details.append(rawManifest);
  return details;
}

function createConfigCard(record: PluginRecord): HTMLElement {
  const card = document.createElement("section");
  card.className = "panel-card";
  card.setAttribute("aria-labelledby", "configuration-heading");
  const configHeading = textElement("h3", "插件配置"); configHeading.id = "configuration-heading"; card.append(configHeading);
  card.append(textElement("p", "按插件 schema 编辑配置。保存时完整替换，校验失败不会覆盖原值。", "muted"));

  const form = document.createElement("form");
  form.noValidate = true;
  form.append(createSchemaFields("config", record.manifest.configSchema, record.config));
  form.append(createAdvancedEditor("config", "高级配置 JSON", "可选；填写后将使用此 JSON 对象替代上方字段。"));
  const save = textElement("button", "保存配置", "button primary") as HTMLButtonElement;
  save.type = "submit";
  form.append(save);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    removeFormError(form);
    try {
      if (!form.querySelector<HTMLTextAreaElement>("textarea[data-advanced-for]")?.value.trim() && !form.reportValidity()) return;
      const config = readInput(form, "config", true) as JsonRecord;
      setButtonBusy(save, true, "正在保存…");
      setStatus("正在保存本地配置…", "working");
      const updated = await api<PluginRecord>(`/api/plugins/${encodeURIComponent(record.manifest.id)}/config`, writeInit("PUT", { config }));
      updatePlugin(updated);
      setStatus("配置已保存到本地。", "success");
      renderPluginList();
      renderPluginWorkspace(updated);
    } catch (error) {
      const issue = errorFrom(error);
      setStatus(`${issue.code}: ${issue.message}`, "error");
      addFormError(form, `${issue.code}: ${issue.message}`);
      setButtonBusy(save, false, "正在保存…");
    }
  });

  card.append(form);
  return card;
}

function createGrantsCard(record: PluginRecord): HTMLElement {
  const card = document.createElement("section");
  card.className = "panel-card";
  card.setAttribute("aria-labelledby", "grants-heading");
  const grantsHeading = textElement("h3", "目录授权"); grantsHeading.id = "grants-heading"; card.append(grantsHeading);
  const declared = record.manifest.permissions.length ? `声明的权限: ${record.manifest.permissions.join(", ")}.` : "此插件未声明文件权限。";
  card.append(textElement("p", `${declared} 只授权你愿意提供给插件的可信目录。`, "muted"));

  const form = document.createElement("form");
  form.className = "inline-form";
  form.noValidate = true;
  const field = document.createElement("div");
  const inputId = `grant-root-${record.manifest.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const label = document.createElement("label");
  label.htmlFor = inputId;
  label.textContent = "要授权的本地目录";
  const root = document.createElement("input");
  root.id = inputId;
  root.type = "text";
  root.required = true;
  root.autocomplete = "off";
  root.spellcheck = false;
  root.placeholder = "/path/to/directory";
  field.append(label, root);
  const grant = textElement("button", "授予读取权限", "button secondary") as HTMLButtonElement;
  grant.type = "submit";
  form.append(field, grant);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    removeFormError(form);
    if (!form.querySelector<HTMLTextAreaElement>("textarea[data-advanced-for]")?.value.trim() && !form.reportValidity()) return;
    try {
      setButtonBusy(grant, true, "正在授权…");
      setStatus("正在授权本地目录…", "working");
      const updated = await api<PluginRecord>(`/api/plugins/${encodeURIComponent(record.manifest.id)}/grants`, writeInit("POST", { root: root.value }));
      updatePlugin(updated);
      setStatus("目录读取权限已授予。", "success");
      renderPluginList();
      renderPluginWorkspace(updated);
    } catch (error) {
      const issue = errorFrom(error);
      setStatus(`${issue.code}: ${issue.message}`, "error");
      addFormError(form, `${issue.code}: ${issue.message}`);
      setButtonBusy(grant, false, "正在授权…");
    }
  });
  card.append(form);

  const roots = record.grants.readRoots;
  if (roots.length === 0) {
    card.append(textElement("p", "当前没有已授权目录。", "grant-empty"));
  } else {
    const list = document.createElement("div");
    list.className = "grant-list";
    roots.forEach((path) => {
      const item = document.createElement("div");
      item.className = "grant-entry";
      item.append(textElement("code", path));
      const revoke = textElement("button", "撤销", "button danger") as HTMLButtonElement;
      revoke.type = "button";
      revoke.setAttribute("aria-label", `撤销目录授权 ${path}`);
      revoke.addEventListener("click", async () => {
        try {
          setButtonBusy(revoke, true, "正在撤销…");
          setStatus("正在撤销目录读取权限…", "working");
          const updated = await api<PluginRecord>(`/api/plugins/${encodeURIComponent(record.manifest.id)}/grants`, writeInit("DELETE", { root: path }));
          updatePlugin(updated);
          setStatus("目录授权已撤销。", "success");
          renderPluginList();
          renderPluginWorkspace(updated);
        } catch (error) {
          const issue = errorFrom(error);
          setStatus(`${issue.code}: ${issue.message}`, "error");
          setButtonBusy(revoke, false, "正在撤销…");
        }
      });
      item.append(revoke);
      list.append(item);
    });
    card.append(list);
  }
  return card;
}

function displayExecution(output: HTMLElement, execution: ExecutionResult | null, requestError?: ApiError | InputError): void {
  clear(output);
  if (requestError) {
    const heading = textElement("p", "执行请求失败", "execution-state error");
    const callout = document.createElement("div");
    callout.className = "error-callout";
    callout.append(textElement("strong", requestError.code), document.createTextNode(requestError.message));
    const raw = document.createElement("pre");
    raw.className = "json-output";
    raw.textContent = stringify({ ok: false, error: { code: requestError.code, message: requestError.message } });
    output.append(heading, callout, raw);
    return;
  }
  if (!execution) return;

  if (execution.ok) {
    output.append(textElement("p", `执行成功 · ${execution.durationMs} ms`, "execution-state success"));
  } else {
    output.append(textElement("p", "执行失败", "execution-state error"));
    const callout = document.createElement("div");
    callout.className = "error-callout";
    const code = execution.error?.code ?? "EXECUTION_FAILED";
    const message = execution.error?.message ?? "插件未返回成功结果。";
    callout.append(textElement("strong", code), document.createTextNode(message));
    output.append(callout);
  }
  const raw = document.createElement("pre");
  raw.className = "json-output";
  raw.textContent = stringify(execution);
  output.append(raw);
}

function createRunCard(record: PluginRecord): HTMLElement {
  const card = document.createElement("section");
  card.className = "panel-card wide";
  card.setAttribute("aria-labelledby", "run-heading");
  const runHeading = textElement("h3", "运行插件能力"); runHeading.id = "run-heading"; card.append(runHeading);
  card.append(textElement("p", "通过统一协议调用声明的能力，结果以结构化 JSON 展示。", "muted"));

  if (record.manifest.capabilities.length === 0) {
    card.append(textElement("p", "插件没有可执行能力。", "muted"));
    return card;
  }

  const capabilityId = `capability-${record.manifest.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const label = document.createElement("label");
  label.htmlFor = capabilityId;
  label.textContent = "能力";
  const select = document.createElement("select");
  select.id = capabilityId;
  select.setAttribute("aria-label", "要运行的能力");
  record.manifest.capabilities.forEach((capability) => {
    const option = document.createElement("option");
    option.value = capability.name;
    option.textContent = capability.name;
    select.append(option);
  });
  card.append(label, select);

  const runner = document.createElement("div");
  const renderRunner = (capabilityName: string): void => {
    clear(runner);
    const capability = record.manifest.capabilities.find((item) => item.name === capabilityName);
    if (!capability) return;
    if (capability.description) runner.append(textElement("p", capability.description, "field-description"));

    const form = document.createElement("form");
    form.noValidate = true;
    form.append(createSchemaFields("input", capability.inputSchema, {}));
    form.append(createAdvancedEditor("input", "高级输入 JSON", "可选；填写后将使用此 JSON 替代上方输入字段。"));
    const timeoutField = document.createElement("div");
    timeoutField.className = "field";
    const timeoutId = `timeout-${record.manifest.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const timeoutLabel = document.createElement("label");
    timeoutLabel.htmlFor = timeoutId;
    timeoutLabel.textContent = "执行超时（毫秒）";
    const timeout = document.createElement("input");
    timeout.id = timeoutId;
    timeout.type = "number";
    timeout.min = "50";
    timeout.max = "30000";
    timeout.step = "1";
    timeout.value = "5000";
    timeout.setAttribute("aria-describedby", `${timeoutId}-hint`);
    const timeoutHint = textElement("p", "允许 50–30000 ms；超时会终止对应执行进程。", "field-hint");
    timeoutHint.id = `${timeoutId}-hint`;
    timeoutField.append(timeoutLabel, timeout, timeoutHint);
    form.append(timeoutField);
    const execute = textElement("button", "运行能力", "button primary") as HTMLButtonElement;
    execute.type = "submit";
    form.append(execute);
    const output = document.createElement("div");
    output.className = "execution-output";
    output.setAttribute("aria-live", "polite");
    output.setAttribute("aria-label", "执行结果");
    if (state.execution && state.execution.capability === capability.name) displayExecution(output, state.execution);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      removeFormError(form);
      try {
        if (!form.querySelector<HTMLTextAreaElement>("textarea[data-advanced-for]")?.value.trim() && !form.reportValidity()) return;
        const parsedTimeout = Number(timeout.value);
        if (!Number.isInteger(parsedTimeout) || parsedTimeout < 50 || parsedTimeout > 30000) {
          throw new InputError("INVALID_TIMEOUT", "超时必须为 50–30000 毫秒的整数。");
        }
        const input = readInput(form, "input", false);
        setButtonBusy(execute, true, "正在运行…");
        setStatus(`正在本地运行 ${capability.name}…`, "working");
        displayExecution(output, null);
        const execution = await api<ExecutionResult>(`/api/plugins/${encodeURIComponent(record.manifest.id)}/run`, writeInit("POST", {
          capability: capability.name,
          input,
          timeoutMs: parsedTimeout,
        }));
        if (state.selectedId !== record.manifest.id) return;
        state.execution = execution;
        displayExecution(output, execution);
        if (execution.ok) {
          setStatus(`能力 ${capability.name} 已执行完成。`, "success");
        } else {
          const code = execution.error?.code ?? "EXECUTION_FAILED";
          const message = execution.error?.message ?? "插件返回了执行错误。";
          setStatus(`${code}: ${message}`, "error");
        }
      } catch (error) {
        const issue = errorFrom(error);
        displayExecution(output, null, issue);
        setStatus(`${issue.code}: ${issue.message}`, "error");
        addFormError(form, `${issue.code}: ${issue.message}`);
      } finally {
        setButtonBusy(execute, false, "正在运行…");
      }
    });

    runner.append(form, output);
  };
  select.addEventListener("change", () => {
    state.execution = null;
    renderRunner(select.value);
  });
  renderRunner(select.value);
  card.append(runner);
  return card;
}

function renderPluginWorkspace(record: PluginRecord): void {
  if (state.selectedId !== record.manifest.id) return;
  clear(detailPanel);

  const header = document.createElement("div");
  header.className = "plugin-header";
  const headline = document.createElement("div");
  headline.append(textElement("p", "当前插件", "eyebrow"));
  const title = textElement("h2", record.manifest.name);
  title.id = "workspace-heading";
  headline.append(title);
  if (record.manifest.description) headline.append(textElement("p", record.manifest.description, "plugin-description"));
  headline.append(textElement("p", `${record.manifest.id} · v${record.manifest.version}`, "plugin-meta"));
  const actions = document.createElement("div");
  actions.className = "plugin-actions";
  actions.append(statusTag(record.enabled));
  const toggle = textElement("button", record.enabled ? "禁用插件" : "启用插件", record.enabled ? "button danger" : "button secondary") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-label", record.enabled ? `禁用 ${record.manifest.name}` : `启用 ${record.manifest.name}`);
  toggle.addEventListener("click", async () => {
    try {
      const action = record.enabled ? "disable" : "enable";
      setButtonBusy(toggle, true, record.enabled ? "正在禁用…" : "正在启用…");
      setStatus(`${record.enabled ? "禁用" : "启用"}插件中…`, "working");
      const updated = await api<PluginRecord>(`/api/plugins/${encodeURIComponent(record.manifest.id)}/${action}`, writeInit("POST", {}));
      updatePlugin(updated);
      state.execution = null;
      setStatus(updated.enabled ? "插件已启用。" : "插件已禁用。", "success");
      renderPluginList();
      renderPluginWorkspace(updated);
    } catch (error) {
      const issue = errorFrom(error);
      setStatus(`${issue.code}: ${issue.message}`, "error");
      setButtonBusy(toggle, false, record.enabled ? "正在禁用…" : "正在启用…");
    }
  });
  actions.append(toggle);
  header.append(headline, actions);

  const grid = document.createElement("div");
  grid.className = "workspace-grid";
  grid.append(createConfigCard(record), createGrantsCard(record), createRunCard(record));
  detailPanel.append(header, grid, createManifestDetails(record));
}

async function selectPlugin(id: string): Promise<void> {
  state.selectedId = id;
  state.execution = null;
  const requestNumber = ++state.selectionRequest;
  renderPluginList();
  renderLoadingWorkspace();
  try {
    const record = await api<PluginRecord>(`/api/plugins/${encodeURIComponent(id)}`);
    if (requestNumber !== state.selectionRequest || state.selectedId !== id) return;
    updatePlugin(record);
    renderPluginList();
    renderPluginWorkspace(record);
    setStatus("插件详情已加载。", "neutral");
  } catch (error) {
    if (requestNumber !== state.selectionRequest || state.selectedId !== id) return;
    const issue = errorFrom(error);
    renderWorkspaceError(issue);
    setStatus(`${issue.code}: ${issue.message}`, "error");
  }
}

async function reloadPlugins(announce = false): Promise<void> {
  try {
    const plugins = await api<PluginRecord[]>("/api/plugins");
    state.plugins = Array.isArray(plugins) ? plugins : [];
    if (state.selectedId && !state.plugins.some((record) => record.manifest.id === state.selectedId)) {
      state.selectedId = null;
      state.execution = null;
      renderInitialWorkspace();
    }
    renderPluginList();
    if (announce) setStatus("插件列表已刷新。", "success");
  } catch (error) {
    state.plugins = [];
    renderPluginList();
    const issue = errorFrom(error);
    setStatus(`${issue.code}: ${issue.message}`, "error");
  }
}

function renderInitialWorkspace(): void {
  clear(detailPanel);
  const panel = document.createElement("div");
  panel.className = "empty-workspace";
  const title = textElement("h2", "选择一个插件");
  title.id = "workspace-heading";
  panel.append(
    textElement("p", "本地工作区", "eyebrow"),
    title,
    textElement("p", "先安装本地插件，再从左侧选择。查看协议和权限，保存配置，启用并运行声明的能力。"),
  );
  detailPanel.append(panel);
}

installForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  removeFormError(installForm);
  const source = installForm.elements.namedItem("source");
  const install = installForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!(source instanceof HTMLInputElement) || !install) return;
  if (!installForm.reportValidity()) return;
  try {
    setButtonBusy(install, true, "正在安装…");
    setStatus("正在安装本地插件包…", "working");
    const record = await api<PluginRecord>("/api/plugins", writeInit("POST", { source: source.value }));
    source.value = "";
    updatePlugin(record);
    renderPluginList();
    setStatus("插件已安装；请检查后再启用。", "success");
    await selectPlugin(record.manifest.id);
  } catch (error) {
    const issue = errorFrom(error);
    setStatus(`${issue.code}: ${issue.message}`, "error");
    addFormError(installForm, `${issue.code}: ${issue.message}`);
  } finally {
    if (install) setButtonBusy(install, false, "正在安装…");
  }
});

refreshButton.addEventListener("click", async () => {
  setButtonBusy(refreshButton, true, "正在刷新…");
  setStatus("正在刷新插件列表…", "working");
  await reloadPlugins(true);
  setButtonBusy(refreshButton, false, "正在刷新…");
});

async function initialize(): Promise<void> {
  try {
    setStatus("正在连接本地宿主…", "working");
    const session = await api<Session>("/api/session");
    if (!session || typeof session.token !== "string" || !session.token) {
      throw new ApiError("INVALID_SESSION", "本地服务未提供有效会话。");
    }
    state.token = session.token;
    connectionNote.textContent = `仅监听 127.0.0.1 · 协议 ${session.protocolVersion}`;
    await reloadPlugins(false);
    if (statusMessage.dataset.tone !== "error") {
      setStatus("本地宿主已连接。", "success");
    }
  } catch (error) {
    const issue = errorFrom(error);
    state.plugins = [];
    renderPluginList();
    setStatus(`${issue.code}: ${issue.message}`, "error");
  }
}

void initialize();
