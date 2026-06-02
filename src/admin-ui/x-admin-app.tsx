import { useEffect, useState } from "react";

import type { PluginAdminNativeMountContext } from "@phantasy/agent/plugin-admin-ui";

import type {
  AgentConfigPayload,
  TemplateWeights,
  TwitterTemplate,
  TwitterTemplates,
  XPlatformConfig,
  XPluginConfig,
  XPluginStatus,
} from "./x-admin-types";

const STYLE_ID = "phantasy-plugin-x-admin-surface";
const STYLE_TEXT = [
  ".phantasyXRoot{min-height:560px;padding:28px;background:radial-gradient(circle at top, rgba(76,201,240,0.14), transparent 28%),radial-gradient(circle at right, rgba(255,255,255,0.08), transparent 26%),linear-gradient(180deg,#071019 0%,#04070d 100%);color:#f3f7fb;font-family:Inter,ui-sans-serif,system-ui,sans-serif;}",
  ".phantasyXRoot *{box-sizing:border-box;}",
  ".phantasyXShell{width:min(1180px,100%);margin:0 auto;display:grid;gap:18px;}",
  ".phantasyXHero{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;align-items:flex-start;}",
  ".phantasyXEyebrow{margin:0 0 10px;color:#7fd8ff;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;}",
  ".phantasyXTitle{margin:0;font-size:clamp(28px,4vw,42px);line-height:1.04;}",
  ".phantasyXLead{max-width:760px;margin:10px 0 0;color:#9db3c7;line-height:1.6;}",
  ".phantasyXHeroActions{display:flex;flex-wrap:wrap;gap:10px;}",
  ".phantasyXButton,.phantasyXGhostButton,.phantasyXDangerButton,.phantasyXTab{appearance:none;border-radius:999px;padding:10px 14px;font:inherit;cursor:pointer;transition:transform 160ms ease,background 160ms ease,border-color 160ms ease;}",
  ".phantasyXButton:hover,.phantasyXGhostButton:hover,.phantasyXDangerButton:hover,.phantasyXTab:hover{transform:translateY(-1px);}",
  ".phantasyXButton{border:1px solid rgba(127,216,255,0.4);background:linear-gradient(135deg,#4cc9f0 0%,#65f0c6 100%);color:#04101a;font-weight:700;}",
  ".phantasyXGhostButton{border:1px solid rgba(127,216,255,0.22);background:rgba(8,20,34,0.85);color:#f3f7fb;}",
  ".phantasyXDangerButton{border:1px solid rgba(255,121,121,0.28);background:rgba(49,12,18,0.72);color:#ffdede;}",
  ".phantasyXButton:disabled,.phantasyXGhostButton:disabled,.phantasyXDangerButton:disabled,.phantasyXTab:disabled{opacity:0.55;cursor:not-allowed;transform:none;}",
  ".phantasyXStatusRow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;}",
  ".phantasyXPill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;border:1px solid rgba(127,216,255,0.2);background:rgba(8,20,34,0.72);font-size:13px;color:#d7e4ef;}",
  ".phantasyXDot{width:8px;height:8px;border-radius:999px;background:#93a6b7;}",
  ".phantasyXDot.isLive{background:#65f0c6;box-shadow:0 0 12px rgba(101,240,198,0.7);}",
  ".phantasyXDot.isWarn{background:#ffd166;box-shadow:0 0 12px rgba(255,209,102,0.7);}",
  ".phantasyXTabs{display:flex;gap:10px;flex-wrap:wrap;}",
  ".phantasyXTab{border:1px solid rgba(127,216,255,0.18);background:rgba(8,20,34,0.72);color:#d7e4ef;}",
  ".phantasyXTabActive{background:rgba(76,201,240,0.18);border-color:rgba(127,216,255,0.44);color:#ffffff;}",
  ".phantasyXPanelGrid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));}",
  ".phantasyXPanel,.phantasyXCard,.phantasyXTemplateCard{border:1px solid rgba(127,216,255,0.16);border-radius:22px;background:rgba(8,20,34,0.82);box-shadow:0 28px 80px rgba(0,0,0,0.28);}",
  ".phantasyXPanel,.phantasyXTemplateCard{padding:18px;}",
  ".phantasyXCard{padding:16px;}",
  ".phantasyXSectionTitle{margin:0;font-size:18px;}",
  ".phantasyXSectionLead{margin:8px 0 0;color:#9db3c7;line-height:1.6;font-size:14px;}",
  ".phantasyXForm{display:grid;gap:14px;}",
  ".phantasyXField{display:grid;gap:8px;}",
  ".phantasyXFieldRow{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;}",
  ".phantasyXLabel{font-size:13px;color:#c8d7e4;font-weight:600;}",
  ".phantasyXInput,.phantasyXTextarea{width:100%;border-radius:14px;border:1px solid rgba(127,216,255,0.18);background:rgba(5,13,23,0.88);color:#f3f7fb;padding:11px 12px;font:inherit;}",
  ".phantasyXTextarea{min-height:96px;resize:vertical;}",
  ".phantasyXHelp{margin:0;color:#8fa6ba;font-size:12px;line-height:1.5;}",
  ".phantasyXCheckbox{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:16px;border:1px solid rgba(127,216,255,0.14);background:rgba(5,13,23,0.64);}",
  ".phantasyXCheckbox input{margin-top:3px;}",
  ".phantasyXCheckboxCopy{display:grid;gap:4px;}",
  ".phantasyXCheckboxTitle{font-weight:600;color:#f3f7fb;}",
  ".phantasyXCheckboxText{color:#95abc0;font-size:13px;line-height:1.5;}",
  ".phantasyXNotice{padding:12px 14px;border-radius:16px;border:1px solid rgba(127,216,255,0.14);font-size:14px;line-height:1.55;}",
  ".phantasyXNotice.isError{background:rgba(78,15,20,0.72);border-color:rgba(255,121,121,0.28);color:#ffdede;}",
  ".phantasyXNotice.isSuccess{background:rgba(10,44,36,0.72);border-color:rgba(101,240,198,0.26);color:#d7fff1;}",
  ".phantasyXNotice.isInfo{background:rgba(7,28,46,0.78);border-color:rgba(127,216,255,0.22);color:#def4ff;}",
  ".phantasyXCardGrid{display:grid;gap:12px;}",
  ".phantasyXKeyValue{display:grid;gap:6px;padding:12px 14px;border-radius:16px;background:rgba(5,13,23,0.64);border:1px solid rgba(127,216,255,0.12);}",
  ".phantasyXKeyLabel{font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#8fa6ba;}",
  ".phantasyXKeyValueText{font-size:14px;color:#f3f7fb;word-break:break-all;}",
  ".phantasyXMetaRow{display:flex;flex-wrap:wrap;gap:8px;}",
  ".phantasyXTemplateToolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;}",
  ".phantasyXTemplateCards{display:grid;gap:14px;}",
  ".phantasyXTemplateHeader{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:flex-start;}",
  ".phantasyXTemplateDescription{margin:6px 0 0;color:#9db3c7;font-size:13px;line-height:1.5;}",
  ".phantasyXPromptList,.phantasyXParamList{display:grid;gap:10px;}",
  ".phantasyXPromptRow,.phantasyXParamRow{display:grid;gap:8px;padding:12px;border-radius:16px;background:rgba(5,13,23,0.64);border:1px solid rgba(127,216,255,0.12);}",
  ".phantasyXInlineActions{display:flex;flex-wrap:wrap;gap:10px;}",
  ".phantasyXMuted{color:#8fa6ba;font-size:13px;}",
  ".phantasyXEmpty{padding:18px;border-radius:18px;border:1px dashed rgba(127,216,255,0.2);color:#9db3c7;background:rgba(5,13,23,0.48);}",
  ".phantasyXDivider{height:1px;background:linear-gradient(90deg,transparent 0%, rgba(127,216,255,0.24) 16%, rgba(127,216,255,0.08) 100%);margin:4px 0;}",
  "@media (max-width:860px){.phantasyXRoot{padding:18px;}.phantasyXPanelGrid{grid-template-columns:1fr;}}",
].join("");

const PLATFORM_NAMES = ["twitter", "x", "x-twitter", "Twitter", "X"] as const;
const DEFAULT_PLUGIN_CONFIG: XPluginConfig = {
  activeHours: "9-21",
  autonomousPosting: false,
  enabled: true,
  maxPostsPerDay: 8,
  postingIntervalMinutes: 60,
  requireApproval: true,
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  casual: "Light, conversational posts about daily activity and personality.",
  educational: "Useful tips, lessons, and explainers for the audience.",
  opinion: "Hot takes, commentary, and strong viewpoints worth sharing.",
  promotional: "Announcements, launches, streams, drops, and partnerships.",
  question: "Community prompts that invite replies, polls, and engagement.",
  shower_thought: "Random realizations, observations, and reflective thoughts.",
  thirst_trap: "Confident image-led posts with a playful or aspirational edge.",
};

type NoticeTone = "error" | "info" | "success";
type TabId = "settings" | "templates";

interface NoticeState {
  message: string;
  tone: NoticeTone;
}

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  doc.head.appendChild(style);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error || "Request failed")
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });

  return parseJsonResponse<T>(response);
}

function normalizePluginConfig(raw: unknown): XPluginConfig {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    activeHours:
      typeof record.activeHours === "string" && record.activeHours.trim()
        ? record.activeHours
        : DEFAULT_PLUGIN_CONFIG.activeHours,
    autonomousPosting: record.autonomousPosting !== false
      ? Boolean(record.autonomousPosting)
      : false,
    enabled: record.enabled !== false,
    maxPostsPerDay:
      typeof record.maxPostsPerDay === "number" && Number.isFinite(record.maxPostsPerDay)
        ? record.maxPostsPerDay
        : DEFAULT_PLUGIN_CONFIG.maxPostsPerDay,
    postingIntervalMinutes:
      typeof record.postingIntervalMinutes === "number" &&
      Number.isFinite(record.postingIntervalMinutes)
        ? record.postingIntervalMinutes
        : DEFAULT_PLUGIN_CONFIG.postingIntervalMinutes,
    requireApproval: record.requireApproval !== false,
  };
}

function cloneTemplates(templates: TwitterTemplates): TwitterTemplates {
  return Object.fromEntries(
    Object.entries(templates).map(([category, template]) => [
      category,
      {
        prompts: Array.isArray(template.prompts) ? [...template.prompts] : [],
        parameters: Object.fromEntries(
          Object.entries(template.parameters || {}).map(([name, values]) => [
            name,
            Array.isArray(values) ? [...values] : [],
          ]),
        ),
      },
    ]),
  );
}

function normalizeTemplates(
  rawTemplates: unknown,
  rawWeights: unknown,
): { templates: TwitterTemplates; weights: TemplateWeights } {
  const templates: TwitterTemplates = {};
  const weights: TemplateWeights = {};
  const templateRecord =
    rawTemplates && typeof rawTemplates === "object" && !Array.isArray(rawTemplates)
      ? (rawTemplates as Record<string, unknown>)
      : {};
  const weightRecord =
    rawWeights && typeof rawWeights === "object" && !Array.isArray(rawWeights)
      ? (rawWeights as Record<string, unknown>)
      : {};

  for (const [category, templateValue] of Object.entries(templateRecord)) {
    const template =
      templateValue && typeof templateValue === "object" && !Array.isArray(templateValue)
        ? (templateValue as Record<string, unknown>)
        : {};
    const prompts = Array.isArray(template.prompts)
      ? template.prompts.filter((entry): entry is string => typeof entry === "string")
      : [];
    const rawParameters =
      template.parameters && typeof template.parameters === "object"
        ? (template.parameters as Record<string, unknown>)
        : {};
    const parameters: Record<string, string[]> = {};

    for (const [name, values] of Object.entries(rawParameters)) {
      parameters[name] = Array.isArray(values)
        ? values.filter((entry): entry is string => typeof entry === "string")
        : [];
    }

    templates[category] = { parameters, prompts };

    const weightValue = weightRecord[category];
    weights[category] =
      typeof weightValue === "number" && Number.isFinite(weightValue)
        ? weightValue
        : 10;
  }

  return {
    templates,
    weights,
  };
}

function createCategoryKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function getCategoryDescription(category: string): string {
  return CATEGORY_DESCRIPTIONS[category] || "Custom template category.";
}

function maskValue(value?: string): string {
  if (!value) {
    return "Not configured";
  }

  return `••••••••${value.slice(-4)}`;
}

function toCsv(values: string[]): string {
  return values.join(", ");
}

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function loadPlatformConfig(): Promise<XPlatformConfig | null> {
  for (const name of PLATFORM_NAMES) {
    try {
      const config = await fetchJson<XPlatformConfig>(
        `/admin/api/platforms/${encodeURIComponent(name)}/config`,
      );
      if (config && Object.keys(config).length > 0) {
        return { ...config, platformName: name };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function NoticeBanner({ notice }: { notice: NoticeState | null }) {
  if (!notice) {
    return null;
  }

  return (
    <div className={`phantasyXNotice is${capitalize(notice.tone)}`}>
      {notice.message}
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function StatusPills({
  platformConfig,
  pluginStatus,
}: {
  platformConfig: XPlatformConfig | null;
  pluginStatus: XPluginStatus | null;
}) {
  const platformEnabled = Boolean(platformConfig?.enabled);
  const pluginConnected = Boolean(pluginStatus?.connected);
  const pluginEnabled = pluginStatus?.enabled ?? false;

  return (
    <div className="phantasyXStatusRow">
      <div className="phantasyXPill">
        <span
          className={`phantasyXDot ${pluginConnected ? "isLive" : pluginEnabled ? "isWarn" : ""}`}
        />
        {pluginConnected
          ? "Connected"
          : pluginEnabled
            ? "Configured"
            : "Plugin disabled"}
      </div>
      <div className="phantasyXPill">
        <span
          className={`phantasyXDot ${platformEnabled ? "isLive" : ""}`}
        />
        {platformEnabled ? "Platform enabled" : "Platform disabled"}
      </div>
      <div className="phantasyXPill">
        Approval {pluginStatus?.autonomousPosting ? "and automation active" : "gated"}
      </div>
    </div>
  );
}

function TemplateCategoryCard(props: {
  category: string;
  onAddParameter: () => void;
  onAddPrompt: () => void;
  onDeleteCategory: () => void;
  onParameterDraftChange: (value: string) => void;
  onParameterValuesChange: (parameterName: string, value: string) => void;
  onPromptChange: (index: number, value: string) => void;
  onRemoveParameter: (parameterName: string) => void;
  onRemovePrompt: (index: number) => void;
  onWeightChange: (value: number) => void;
  parameterDraft: string;
  template: TwitterTemplate;
  weight: number;
}) {
  const {
    category,
    onAddParameter,
    onAddPrompt,
    onDeleteCategory,
    onParameterDraftChange,
    onParameterValuesChange,
    onPromptChange,
    onRemoveParameter,
    onRemovePrompt,
    onWeightChange,
    parameterDraft,
    template,
    weight,
  } = props;

  return (
    <article className="phantasyXTemplateCard">
      <div className="phantasyXTemplateHeader">
        <div>
          <h3 className="phantasyXSectionTitle">{category}</h3>
          <p className="phantasyXTemplateDescription">
            {getCategoryDescription(category)}
          </p>
        </div>
        <div className="phantasyXInlineActions">
          <div className="phantasyXField">
            <label className="phantasyXLabel" htmlFor={`weight-${category}`}>
              Weight
            </label>
            <input
              id={`weight-${category}`}
              className="phantasyXInput"
              min={0}
              step={1}
              type="number"
              value={weight}
              onChange={(event) => onWeightChange(Number(event.target.value || 0))}
            />
          </div>
          <button
            className="phantasyXDangerButton"
            type="button"
            onClick={onDeleteCategory}
          >
            Delete category
          </button>
        </div>
      </div>

      <div className="phantasyXDivider" />

      <div className="phantasyXField">
        <div className="phantasyXTemplateToolbar">
          <div>
            <h4 className="phantasyXSectionTitle">Prompts</h4>
            <p className="phantasyXSectionLead">
              One category can hold multiple prompt variants for autonomous posting.
            </p>
          </div>
          <button className="phantasyXGhostButton" type="button" onClick={onAddPrompt}>
            Add prompt
          </button>
        </div>
        <div className="phantasyXPromptList">
          {template.prompts.length === 0 ? (
            <div className="phantasyXEmpty">No prompts yet. Add one to start.</div>
          ) : null}
          {template.prompts.map((prompt, index) => (
            <div key={`${category}-prompt-${index}`} className="phantasyXPromptRow">
              <label className="phantasyXLabel" htmlFor={`${category}-prompt-${index}`}>
                Prompt {index + 1}
              </label>
              <textarea
                id={`${category}-prompt-${index}`}
                className="phantasyXTextarea"
                value={prompt}
                onChange={(event) => onPromptChange(index, event.target.value)}
              />
              <div className="phantasyXInlineActions">
                <button
                  className="phantasyXDangerButton"
                  type="button"
                  onClick={() => onRemovePrompt(index)}
                >
                  Remove prompt
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="phantasyXDivider" />

      <div className="phantasyXField">
        <div className="phantasyXTemplateToolbar">
          <div>
            <h4 className="phantasyXSectionTitle">Parameters</h4>
            <p className="phantasyXSectionLead">
              Values are comma-separated. Use these tokens in prompts like {"{topic}"}.
            </p>
          </div>
        </div>

        <div className="phantasyXFieldRow">
          <div className="phantasyXField">
            <label className="phantasyXLabel" htmlFor={`${category}-new-parameter`}>
              New parameter name
            </label>
            <input
              id={`${category}-new-parameter`}
              className="phantasyXInput"
              placeholder="topic"
              value={parameterDraft}
              onChange={(event) => onParameterDraftChange(event.target.value)}
            />
          </div>
          <div className="phantasyXField" style={{ alignSelf: "end" }}>
            <button className="phantasyXGhostButton" type="button" onClick={onAddParameter}>
              Add parameter
            </button>
          </div>
        </div>

        <div className="phantasyXParamList">
          {Object.keys(template.parameters).length === 0 ? (
            <div className="phantasyXEmpty">
              No parameters yet. Add one to control prompt substitutions.
            </div>
          ) : null}
          {Object.entries(template.parameters).map(([parameterName, values]) => (
            <div key={`${category}-${parameterName}`} className="phantasyXParamRow">
              <label
                className="phantasyXLabel"
                htmlFor={`${category}-parameter-${parameterName}`}
              >
                {parameterName}
              </label>
              <input
                id={`${category}-parameter-${parameterName}`}
                className="phantasyXInput"
                value={toCsv(values)}
                onChange={(event) =>
                  onParameterValuesChange(parameterName, event.target.value)
                }
              />
              <p className="phantasyXHelp">
                Enter multiple values separated by commas.
              </p>
              <div className="phantasyXInlineActions">
                <button
                  className="phantasyXDangerButton"
                  type="button"
                  onClick={() => onRemoveParameter(parameterName)}
                >
                  Remove parameter
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function XAdminApp({
  context,
}: {
  context: PluginAdminNativeMountContext;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("settings");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingTemplates, setIsSavingTemplates] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [pluginConfig, setPluginConfig] = useState<XPluginConfig>(
    DEFAULT_PLUGIN_CONFIG,
  );
  const [platformConfig, setPlatformConfig] = useState<XPlatformConfig | null>(null);
  const [pluginStatus, setPluginStatus] = useState<XPluginStatus | null>(null);
  const [agentConfig, setAgentConfig] = useState<AgentConfigPayload | null>(null);
  const [templates, setTemplates] = useState<TwitterTemplates>({});
  const [weights, setWeights] = useState<TemplateWeights>({});
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryWeight, setNewCategoryWeight] = useState(10);
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, string>>(
    {},
  );

  useEffect(() => {
    ensureStyles(document);
  }, []);

  useEffect(() => {
    void loadAll(true);
  }, [context.pluginBasePath]);

  const totalWeight = Object.values(weights).reduce(
    (sum, value) => sum + (value || 0),
    0,
  );

  async function loadAll(initialLoad: boolean): Promise<void> {
    if (initialLoad) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    setNotice(null);

    try {
      const [loadedPluginConfig, loadedPlatformConfig, loadedAgentConfig, loadedStatus] =
        await Promise.all([
          fetchJson<Record<string, unknown>>(`${context.pluginBasePath}/config`),
          loadPlatformConfig(),
          fetchJson<AgentConfigPayload>("/admin/api/agent"),
          fetchJson<XPluginStatus>(`${context.pluginBasePath}/status`).catch(
            () => null as XPluginStatus | null,
          ),
        ]);

      const nextPluginConfig = normalizePluginConfig(loadedPluginConfig);
      const nextAgentConfig = loadedAgentConfig || {};
      const nextTwitterConfig =
        nextAgentConfig.twitter && typeof nextAgentConfig.twitter === "object"
          ? nextAgentConfig.twitter
          : {};
      const normalized = normalizeTemplates(
        nextTwitterConfig.templates,
        nextTwitterConfig.templateWeights,
      );

      setPluginConfig(nextPluginConfig);
      setPlatformConfig(loadedPlatformConfig);
      setPluginStatus(
        loadedStatus || {
          autonomousPosting: nextPluginConfig.autonomousPosting,
          connected: Boolean(loadedPlatformConfig),
          enabled: nextPluginConfig.enabled,
        },
      );
      setAgentConfig(nextAgentConfig);
      setTemplates(cloneTemplates(normalized.templates));
      setWeights({ ...normalized.weights });
      setParameterDrafts({});
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : "Failed to load the X plugin surface.",
        tone: "error",
      });
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  async function saveSettings(): Promise<void> {
    setIsSavingSettings(true);
    setNotice(null);

    try {
      await fetchJson(`${context.pluginBasePath}/config`, {
        body: JSON.stringify(pluginConfig),
        method: "PUT",
      });
      const refreshedStatus = await fetchJson<XPluginStatus>(
        `${context.pluginBasePath}/status`,
      ).catch(() => null as XPluginStatus | null);
      if (refreshedStatus) {
        setPluginStatus(refreshedStatus);
      }
      setNotice({
        message: "X plugin settings saved.",
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : "Failed to save X plugin settings.",
        tone: "error",
      });
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveTemplates(): Promise<void> {
    if (!agentConfig) {
      setNotice({
        message: "Agent configuration is not available yet.",
        tone: "error",
      });
      return;
    }

    setIsSavingTemplates(true);
    setNotice(null);

    try {
      const nextAgentConfig: AgentConfigPayload = {
        ...agentConfig,
        twitter: {
          ...(agentConfig.twitter || {}),
          templateWeights: { ...weights },
          templates: cloneTemplates(templates),
        },
      };

      const saved = await fetchJson<AgentConfigPayload>("/admin/api/agent", {
        body: JSON.stringify(nextAgentConfig),
        method: "PUT",
      });

      setAgentConfig(saved);
      setNotice({
        message: "Twitter templates saved to the agent config.",
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : "Failed to save Twitter templates.",
        tone: "error",
      });
    } finally {
      setIsSavingTemplates(false);
    }
  }

  function updateConfigField<K extends keyof XPluginConfig>(
    key: K,
    value: XPluginConfig[K],
  ): void {
    setPluginConfig((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function updatePrompt(category: string, index: number, value: string): void {
    setTemplates((current) => ({
      ...current,
      [category]: {
        ...current[category],
        prompts: current[category].prompts.map((prompt, promptIndex) =>
          promptIndex === index ? value : prompt,
        ),
      },
    }));
  }

  function addPrompt(category: string): void {
    setTemplates((current) => ({
      ...current,
      [category]: {
        ...current[category],
        prompts: [...current[category].prompts, ""],
      },
    }));
  }

  function removePrompt(category: string, index: number): void {
    setTemplates((current) => ({
      ...current,
      [category]: {
        ...current[category],
        prompts: current[category].prompts.filter(
          (_prompt, promptIndex) => promptIndex !== index,
        ),
      },
    }));
  }

  function updateParameterValues(
    category: string,
    parameterName: string,
    value: string,
  ): void {
    setTemplates((current) => ({
      ...current,
      [category]: {
        ...current[category],
        parameters: {
          ...current[category].parameters,
          [parameterName]: parseCsv(value),
        },
      },
    }));
  }

  function removeParameter(category: string, parameterName: string): void {
    setTemplates((current) => {
      const { [parameterName]: _removed, ...remaining } =
        current[category].parameters;
      return {
        ...current,
        [category]: {
          ...current[category],
          parameters: remaining,
        },
      };
    });
  }

  function addParameter(category: string): void {
    const nextName = createCategoryKey(parameterDrafts[category] || "");
    if (!nextName) {
      setNotice({
        message: "Parameter names must contain at least one letter or number.",
        tone: "error",
      });
      return;
    }

    setTemplates((current) => ({
      ...current,
      [category]: {
        ...current[category],
        parameters: {
          ...current[category].parameters,
          [nextName]: current[category].parameters[nextName] || [""],
        },
      },
    }));
    setParameterDrafts((current) => ({ ...current, [category]: "" }));
  }

  function createCategory(): void {
    const categoryKey = createCategoryKey(newCategoryName);
    if (!categoryKey) {
      setNotice({
        message: "Category names must contain at least one letter or number.",
        tone: "error",
      });
      return;
    }

    if (templates[categoryKey]) {
      setNotice({
        message: `Category "${categoryKey}" already exists.`,
        tone: "error",
      });
      return;
    }

    setTemplates((current) => ({
      ...current,
      [categoryKey]: {
        parameters: {},
        prompts: [""],
      },
    }));
    setWeights((current) => ({
      ...current,
      [categoryKey]: Math.max(0, Number(newCategoryWeight) || 0),
    }));
    setNewCategoryName("");
    setNewCategoryWeight(10);
  }

  function deleteCategory(category: string): void {
    setTemplates((current) => {
      const { [category]: _removed, ...remaining } = current;
      return remaining;
    });
    setWeights((current) => {
      const { [category]: _removed, ...remaining } = current;
      return remaining;
    });
    setParameterDrafts((current) => {
      const { [category]: _removed, ...remaining } = current;
      return remaining;
    });
  }

  if (isLoading) {
    return (
      <div className="phantasyXRoot">
        <div className="phantasyXShell">
          <div className="phantasyXNotice isInfo">Loading X plugin surface...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="phantasyXRoot">
      <div className="phantasyXShell">
        <header className="phantasyXHero">
          <div>
            <p className="phantasyXEyebrow">Plugin native surface</p>
            <h1 className="phantasyXTitle">X</h1>
            <p className="phantasyXLead">
              The X plugin owns this tab directly. Settings stay in plugin config,
              while posting templates still round-trip through the agent config
              until they are fully migrated into the plugin itself.
            </p>
          </div>
          <div className="phantasyXHeroActions">
            <button
              className="phantasyXGhostButton"
              type="button"
              onClick={() => void loadAll(false)}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              className="phantasyXGhostButton"
              type="button"
              onClick={() => context.onNavigateToIntegrations?.()}
            >
              Open Integrations
            </button>
          </div>
        </header>

        <StatusPills platformConfig={platformConfig} pluginStatus={pluginStatus} />
        <NoticeBanner notice={notice} />

        <div className="phantasyXTabs">
          <button
            className={`phantasyXTab ${activeTab === "settings" ? "phantasyXTabActive" : ""}`}
            type="button"
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
          <button
            className={`phantasyXTab ${activeTab === "templates" ? "phantasyXTabActive" : ""}`}
            type="button"
            onClick={() => setActiveTab("templates")}
          >
            Templates
          </button>
        </div>

        {activeTab === "settings" ? (
          <section className="phantasyXPanelGrid">
            <section className="phantasyXPanel">
              <h2 className="phantasyXSectionTitle">Plugin settings</h2>
              <p className="phantasyXSectionLead">
                These values live in the plugin config and can travel with an installable
                plugin package.
              </p>

              <div className="phantasyXForm">
                <label className="phantasyXCheckbox">
                  <input
                    checked={pluginConfig.enabled}
                    type="checkbox"
                    onChange={(event) =>
                      updateConfigField("enabled", event.target.checked)
                    }
                  />
                  <span className="phantasyXCheckboxCopy">
                    <span className="phantasyXCheckboxTitle">Enable X plugin</span>
                    <span className="phantasyXCheckboxText">
                      Turns the integration on or off without removing the install.
                    </span>
                  </span>
                </label>

                <label className="phantasyXCheckbox">
                  <input
                    checked={pluginConfig.autonomousPosting}
                    type="checkbox"
                    onChange={(event) =>
                      updateConfigField("autonomousPosting", event.target.checked)
                    }
                  />
                  <span className="phantasyXCheckboxCopy">
                    <span className="phantasyXCheckboxTitle">
                      Enable autonomous posting
                    </span>
                    <span className="phantasyXCheckboxText">
                      Allows the companion to publish through X on its own schedule.
                    </span>
                  </span>
                </label>

                <label className="phantasyXCheckbox">
                  <input
                    checked={pluginConfig.requireApproval}
                    type="checkbox"
                    onChange={(event) =>
                      updateConfigField("requireApproval", event.target.checked)
                    }
                  />
                  <span className="phantasyXCheckboxCopy">
                    <span className="phantasyXCheckboxTitle">
                      Require manual approval
                    </span>
                    <span className="phantasyXCheckboxText">
                      Draft tweets and replies for human review instead of posting directly.
                    </span>
                  </span>
                </label>

                <div className="phantasyXFieldRow">
                  <div className="phantasyXField">
                    <label className="phantasyXLabel" htmlFor="x-posting-interval">
                      Posting interval (minutes)
                    </label>
                    <input
                      id="x-posting-interval"
                      className="phantasyXInput"
                      min={1}
                      step={1}
                      type="number"
                      value={pluginConfig.postingIntervalMinutes}
                      onChange={(event) =>
                        updateConfigField(
                          "postingIntervalMinutes",
                          Number(event.target.value || 1),
                        )
                      }
                    />
                  </div>

                  <div className="phantasyXField">
                    <label className="phantasyXLabel" htmlFor="x-max-posts">
                      Max posts per day
                    </label>
                    <input
                      id="x-max-posts"
                      className="phantasyXInput"
                      min={1}
                      step={1}
                      type="number"
                      value={pluginConfig.maxPostsPerDay}
                      onChange={(event) =>
                        updateConfigField(
                          "maxPostsPerDay",
                          Number(event.target.value || 1),
                        )
                      }
                    />
                  </div>
                </div>

                <div className="phantasyXField">
                  <label className="phantasyXLabel" htmlFor="x-active-hours">
                    Active hours
                  </label>
                  <input
                    id="x-active-hours"
                    className="phantasyXInput"
                    placeholder="9-21"
                    value={pluginConfig.activeHours}
                    onChange={(event) =>
                      updateConfigField("activeHours", event.target.value)
                    }
                  />
                  <p className="phantasyXHelp">
                    Use a simple hour range like <code>9-21</code> for the local posting
                    window.
                  </p>
                </div>

                <div className="phantasyXInlineActions">
                  <button
                    className="phantasyXButton"
                    type="button"
                    onClick={() => void saveSettings()}
                    disabled={isSavingSettings}
                  >
                    {isSavingSettings ? "Saving..." : "Save settings"}
                  </button>
                </div>
              </div>
            </section>

            <section className="phantasyXPanel">
              <h2 className="phantasyXSectionTitle">Platform credentials</h2>
              <p className="phantasyXSectionLead">
                Credentials are still owned by the shared Integrations surface, so this
                tab reads them in a masked, read-only state.
              </p>

              <div className="phantasyXCardGrid">
                <div className="phantasyXKeyValue">
                  <span className="phantasyXKeyLabel">Platform entry</span>
                  <span className="phantasyXKeyValueText">
                    {platformConfig?.platformName || "twitter"}
                  </span>
                </div>
                <div className="phantasyXKeyValue">
                  <span className="phantasyXKeyLabel">API key</span>
                  <span className="phantasyXKeyValueText">
                    {maskValue(platformConfig?.apiKey)}
                  </span>
                </div>
                <div className="phantasyXKeyValue">
                  <span className="phantasyXKeyLabel">API key secret</span>
                  <span className="phantasyXKeyValueText">
                    {maskValue(platformConfig?.apiKeySecret)}
                  </span>
                </div>
                <div className="phantasyXKeyValue">
                  <span className="phantasyXKeyLabel">Access token</span>
                  <span className="phantasyXKeyValueText">
                    {maskValue(platformConfig?.accessToken)}
                  </span>
                </div>
                <div className="phantasyXKeyValue">
                  <span className="phantasyXKeyLabel">Access token secret</span>
                  <span className="phantasyXKeyValueText">
                    {maskValue(platformConfig?.accessTokenSecret)}
                  </span>
                </div>
                <div className="phantasyXKeyValue">
                  <span className="phantasyXKeyLabel">Plugin status</span>
                  <span className="phantasyXKeyValueText">
                    {pluginStatus?.connected
                      ? "Connected"
                      : pluginStatus?.enabled
                        ? "Configured"
                        : "Disabled"}
                  </span>
                </div>
              </div>

              <div className="phantasyXMetaRow">
                <button
                  className="phantasyXGhostButton"
                  type="button"
                  onClick={() => context.onNavigateToIntegrations?.()}
                >
                  Manage credentials in Integrations
                </button>
              </div>
            </section>
          </section>
        ) : (
          <section className="phantasyXPanel">
            <div className="phantasyXTemplateToolbar">
              <div>
                <h2 className="phantasyXSectionTitle">Posting templates</h2>
                <p className="phantasyXSectionLead">
                  These are still stored in the agent config today. The plugin-owned tab now
                  edits them directly so the host no longer needs a bespoke X screen.
                </p>
              </div>
              <div className="phantasyXMetaRow">
                <div className="phantasyXPill">Total weight: {totalWeight}</div>
                <button
                  className="phantasyXButton"
                  type="button"
                  onClick={() => void saveTemplates()}
                  disabled={isSavingTemplates}
                >
                  {isSavingTemplates ? "Saving..." : "Save templates"}
                </button>
              </div>
            </div>

            <div className="phantasyXFieldRow">
              <div className="phantasyXField">
                <label className="phantasyXLabel" htmlFor="x-new-category">
                  New category name
                </label>
                <input
                  id="x-new-category"
                  className="phantasyXInput"
                  placeholder="promotional"
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                />
              </div>
              <div className="phantasyXField">
                <label className="phantasyXLabel" htmlFor="x-new-category-weight">
                  Starting weight
                </label>
                <input
                  id="x-new-category-weight"
                  className="phantasyXInput"
                  min={0}
                  step={1}
                  type="number"
                  value={newCategoryWeight}
                  onChange={(event) =>
                    setNewCategoryWeight(Number(event.target.value || 0))
                  }
                />
              </div>
              <div className="phantasyXField" style={{ alignSelf: "end" }}>
                <button className="phantasyXGhostButton" type="button" onClick={createCategory}>
                  Add category
                </button>
              </div>
            </div>

            <div className="phantasyXTemplateCards">
              {Object.keys(templates).length === 0 ? (
                <div className="phantasyXEmpty">
                  No Twitter template categories are configured yet.
                </div>
              ) : null}
              {Object.entries(templates).map(([category, template]) => (
                <TemplateCategoryCard
                  key={category}
                  category={category}
                  parameterDraft={parameterDrafts[category] || ""}
                  template={template}
                  weight={weights[category] || 0}
                  onAddParameter={() => addParameter(category)}
                  onAddPrompt={() => addPrompt(category)}
                  onDeleteCategory={() => deleteCategory(category)}
                  onParameterDraftChange={(value) =>
                    setParameterDrafts((current) => ({
                      ...current,
                      [category]: value,
                    }))
                  }
                  onParameterValuesChange={(parameterName, value) =>
                    updateParameterValues(category, parameterName, value)
                  }
                  onPromptChange={(index, value) =>
                    updatePrompt(category, index, value)
                  }
                  onRemoveParameter={(parameterName) =>
                    removeParameter(category, parameterName)
                  }
                  onRemovePrompt={(index) => removePrompt(category, index)}
                  onWeightChange={(value) =>
                    setWeights((current) => ({
                      ...current,
                      [category]: Math.max(0, value),
                    }))
                  }
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
