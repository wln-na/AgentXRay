import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { DirSettings, LlmProfileInput, LlmPurpose } from '@/api/client';
import { getBackupStatus, getLlmSettings, runBackup, saveLlmSettings } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatBytes } from '@/lib/pure';
import { EMPTY_SETTINGS, useAppStore } from '@/store';

const DIR_FIELDS: { key: keyof DirSettings; label: string; placeholder: string }[] = [
  { key: 'openclawDir', label: 'OpenClaw Directory', placeholder: '~/.openclaw/agents' },
  { key: 'codexDir', label: 'Codex Directory', placeholder: '~/.codex/sessions' },
  { key: 'claudeCodeDir', label: 'Claude Code Directory', placeholder: '~/.claude/projects' },
  {
    key: 'claudeDesktopDir',
    label: 'Claude Desktop Directory',
    placeholder: '~/Library/Application Support/Claude-3p/local-agent-mode-sessions',
  },
  { key: 'hermesDir', label: 'Hermes Directory', placeholder: '~/.hermes' },
  { key: 'ompDir', label: 'OMP Directory', placeholder: '~/.omp/agent/sessions' },
  { key: 'dshDir', label: 'DeepSeek Harness Directory', placeholder: '~/.dsh/sessions' },
  { key: 'geminiDir', label: 'Gemini CLI Directory', placeholder: '~/.gemini/tmp' },
  { key: 'cursorDir', label: 'Cursor Directory', placeholder: '~/.cursor/projects' },
  { key: 'doubaoDir', label: 'Doubao Directory', placeholder: '~/.doubao/agent_mode/workspace/.sessions' },
  { key: 'workbuddyDir', label: 'WorkBuddy Directory', placeholder: '~/.workbuddy/projects' },
  { key: 'traeDir', label: 'Trae CN Directory', placeholder: '~/.trae/cli/sessions' },
];

function BackupSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['backup-status'], queryFn: getBackupStatus });
  const backup = useMutation({
    mutationFn: runBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backup-status'] }),
  });

  const statusLine = status.data
    ? `归档目录 ${status.data.archiveDir} · 文件数 ${status.data.files} · 占用 ${formatBytes(status.data.bytes)} · 上次备份 ${
        status.data.lastBackup ? new Date(status.data.lastBackup).toLocaleString() : '从未'
      }`
    : '';
  const error = backup.error
    ? `备份失败: ${(backup.error as Error).message}`
    : status.error
      ? `备份状态获取失败: ${(status.error as Error).message}`
      : null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">会话备份（codex / claude-code / claude-desktop / omp 增量归档）</p>
      <div className="flex items-center gap-2.5">
        <Button variant="outline" size="sm" disabled={backup.isPending} onClick={() => backup.mutate()}>
          {backup.isPending ? '备份中…' : '立即备份'}
        </Button>
        {backup.data && (
          <span className="text-xs text-muted-foreground">
            完成：新增 {backup.data.copied}，跳过 {backup.data.skipped}
          </span>
        )}
      </div>
      {statusLine && <div className="text-xs text-muted-foreground">{statusLine}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

type DraftLlmProfile = LlmProfileInput & { clearApiKey?: boolean };

function blankProfile(): DraftLlmProfile {
  return { type: 'openai-compatible', baseUrl: '', model: '', apiKey: '', clearApiKey: false };
}

function LlmSection() {
  const queryClient = useQueryClient();
  const llm = useQuery({ queryKey: ['llm-settings'], queryFn: getLlmSettings });
  const [draftProfiles, setDraftProfiles] = useState<Record<string, DraftLlmProfile>>({});
  const [activeProfile, setActiveProfile] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [newProfileName, setNewProfileName] = useState('');

  useEffect(() => {
    if (!llm.data) return;
    const profiles = Object.fromEntries(
      Object.entries(llm.data.profiles).map(([name, profile]) => [name, { ...profile, apiKey: '', clearApiKey: false }])
    );
    setDraftProfiles(profiles);
    setActiveProfile(llm.data.activeProfile);
    setSelectedProfile(llm.data.activeProfile || Object.keys(profiles)[0] || '');
  }, [llm.data]);

  // 按功能路由的界面已移除；保存时原样带回，避免把已有配置清空。
  const routes: Partial<Record<LlmPurpose, string | null>> = llm.data?.routes ?? {};
  const profileNames = Object.keys(draftProfiles);
  const current = draftProfiles[selectedProfile] || blankProfile();
  const updateCurrent = (patch: Partial<DraftLlmProfile>) => {
    if (!selectedProfile) return;
    setDraftProfiles((profiles) => ({
      ...profiles,
      [selectedProfile]: { ...profiles[selectedProfile], ...patch },
    }));
  };

  const addProfile = () => {
    const name = newProfileName.trim();
    if (!name || draftProfiles[name]) return;
    setDraftProfiles((profiles) => ({ ...profiles, [name]: blankProfile() }));
    setSelectedProfile(name);
    setNewProfileName('');
  };

  const removeProfile = () => {
    if (!selectedProfile) return;
    const next = { ...draftProfiles };
    delete next[selectedProfile];
    const nextSelected = Object.keys(next)[0] || '';
    setDraftProfiles(next);
    setSelectedProfile(nextSelected);
    if (activeProfile === selectedProfile) setActiveProfile(nextSelected);
  };

  const save = useMutation({
    mutationFn: () => saveLlmSettings({ activeProfile, profiles: draftProfiles, routes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
    },
  });

  const backendLabel =
    llm.data?.backend === 'openai'
      ? 'OpenAI 兼容端点'
      : llm.data?.backend === 'claude-cli'
        ? '本机 claude CLI'
        : '未配置';

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        LLM 后端（本地配置，不会提交到仓库）— 当前 active profile：{activeProfile || '未配置'}（{backendLabel}）
      </p>
      <div className="flex gap-1.5">
        <select
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          value={selectedProfile}
          onChange={(e) => setSelectedProfile(e.target.value)}
        >
          {profileNames.length ? (
            profileNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))
          ) : (
            <option value="">无 profile</option>
          )}
        </select>
        <Input
          className="max-w-36"
          placeholder="新 profile 名"
          value={newProfileName}
          onChange={(e) => setNewProfileName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addProfile()}
        />
        <Button variant="outline" size="sm" onClick={addProfile} disabled={!newProfileName.trim()}>
          新增
        </Button>
        <Button variant="outline" size="sm" onClick={removeProfile} disabled={!selectedProfile}>
          删除
        </Button>
      </div>
      {selectedProfile ? (
        <>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={current.type}
            onChange={(e) => updateCurrent({ type: e.target.value as DraftLlmProfile['type'] })}
          >
            <option value="openai-compatible">OpenAI-compatible / Ollama</option>
            <option value="claude-cli">本机 claude CLI</option>
          </select>
          {current.type === 'openai-compatible' ? (
            <>
              <Input
                placeholder="Base URL，如 https://api.openai.com/v1 或 http://localhost:11434/v1"
                value={current.baseUrl}
                onChange={(e) => updateCurrent({ baseUrl: e.target.value })}
              />
              <div className="flex gap-1.5">
                <Input
                  placeholder="模型名，如 gpt-4o-mini / qwen2.5"
                  value={current.model}
                  onChange={(e) => updateCurrent({ model: e.target.value })}
                />
                <Input
                  type="password"
                  placeholder={
                    llm.data?.profiles[selectedProfile]?.hasApiKey
                      ? 'API Key（已保存，留空保持不变）'
                      : 'API Key（本地端点可留空）'
                  }
                  value={current.apiKey || ''}
                  onChange={(e) => updateCurrent({ apiKey: e.target.value, clearApiKey: false })}
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={current.clearApiKey === true}
                  onChange={(e) => updateCurrent({ clearApiKey: e.target.checked, apiKey: '' })}
                />
                清除已保存的 API Key
              </label>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">使用服务器 PATH 中可执行的 `claude` 命令。</p>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="radio"
              name="active-llm-profile"
              checked={activeProfile === selectedProfile}
              onChange={() => setActiveProfile(selectedProfile)}
            />
            设为默认 profile
          </label>
        </>
      ) : null}
      <div className="flex items-center gap-2.5">
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '保存中…' : '保存 LLM 配置'}
        </Button>
        <span className="text-xs text-muted-foreground">配置保存在 ~/.agentxray/llm.json</span>
      </div>
      {save.error && <div className="text-xs text-danger">保存失败: {(save.error as Error).message}</div>}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DirSettings>(settings);

  // Re-seed the draft from the store every time the dialog opens (legacy openSettings()).
  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(useAppStore.getState().settings);
    onOpenChange(next);
  };

  const save = () => {
    saveSettings({
      openclawDir: draft.openclawDir.trim(),
      codexDir: draft.codexDir.trim(),
      claudeCodeDir: draft.claudeCodeDir.trim(),
      claudeDesktopDir: draft.claudeDesktopDir.trim(),
      hermesDir: draft.hermesDir.trim(),
      ompDir: draft.ompDir.trim(),
      dshDir: draft.dshDir.trim(),
      geminiDir: draft.geminiDir.trim(),
      cursorDir: draft.cursorDir.trim(),
      doubaoDir: draft.doubaoDir.trim(),
      workbuddyDir: draft.workbuddyDir.trim(),
      traeDir: draft.traeDir.trim(),
    });
    onOpenChange(false);
    // Legacy refreshAll(false): every dir-dependent query must refetch.
    queryClient.invalidateQueries();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {DIR_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor={`setting-${field.key}`}>
                {field.label}
              </label>
              <Input
                id={`setting-${field.key}`}
                value={draft[field.key]}
                placeholder={field.placeholder}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              />
            </div>
          ))}
          <LlmSection />
          <BackupSection />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setDraft({ ...EMPTY_SETTINGS })}>
            Reset to Defaults
          </Button>
          <Button onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
