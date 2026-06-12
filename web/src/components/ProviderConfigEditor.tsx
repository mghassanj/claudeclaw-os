import { useEffect, useRef, useState } from 'preact/hooks';
import { useFetch } from '@/lib/useFetch';

export interface ProviderConfig {
  type: 'claude' | 'opencode' | 'gemini' | 'codex' | 'acp';
  model?: string;
  runtimeMode?: string;
  thinkingMode?: string;
  command?: string;
  args?: string[];
}

interface ProviderModelOption { id: string; label: string; }
interface ProviderModelsResponse {
  provider: string;
  models: ProviderModelOption[];
  defaultModel: string;
  selectable: boolean;
  allowCustom?: boolean;
  note?: string;
}
interface ProviderRuntimeOption { id: string; label: string; current?: boolean; }
interface ProviderRuntimeOptionsResponse {
  provider: string;
  modeOptions: ProviderRuntimeOption[];
  thinkingOptions: ProviderRuntimeOption[];
  source: 'provider' | 'fallback' | 'static';
  error?: string;
}

function normalizeProviderType(
  nextType: ProviderConfig['type'],
  acpEnabled: boolean,
): ProviderConfig['type'] {
  return acpEnabled || nextType === 'claude' ? nextType : 'claude';
}

export function ProviderConfigEditor({
  value,
  fallbackModel,
  acpEnabled = true,
  onChange,
  onSave,
  saveLabel = 'Save provider',
  busy = false,
}: {
  value?: ProviderConfig;
  fallbackModel?: string;
  acpEnabled?: boolean;
  onChange?: (provider: ProviderConfig) => void;
  onSave?: (provider: ProviderConfig) => void | Promise<void>;
  saveLabel?: string;
  busy?: boolean;
}) {
  const initial = value ?? { type: 'opencode' as const };
  const [type, setType] = useState<ProviderConfig['type']>(normalizeProviderType(initial.type, acpEnabled));
  const models = useFetch<ProviderModelsResponse>('/api/providers/models?provider=' + encodeURIComponent(type), 0);
  const [model, setModel] = useState(initial.model ?? fallbackModel ?? '');
  const [customModel, setCustomModel] = useState('');
  const [runtimeMode, setRuntimeMode] = useState(initial.runtimeMode ?? '');
  const [thinkingMode, setThinkingMode] = useState(initial.thinkingMode ?? '');
  const [command, setCommand] = useState(initial.command ?? '');
  const [args, setArgs] = useState((initial.args ?? []).join(' '));
  const dirtyRef = useRef(false);

  const runtimeOptionsPath = type === 'acp' && !command.trim()
    ? null
    : '/api/providers/runtime-options?provider='
      + encodeURIComponent(type)
      + (type === 'acp' ? '&command=' + encodeURIComponent(command.trim()) + '&args=' + encodeURIComponent(args) : '');
  const runtimeOptions = useFetch<ProviderRuntimeOptionsResponse>(runtimeOptionsPath, 0);

  function markDirty() {
    dirtyRef.current = true;
  }

  function providerPayload(): ProviderConfig {
    const selectedModel = model === '__custom__' ? customModel.trim() : model.trim();
    const provider: ProviderConfig = { type };
    if (selectedModel && selectedModel !== 'provider-default') provider.model = selectedModel;
    if (runtimeMode) provider.runtimeMode = runtimeMode;
    if (thinkingMode) provider.thinkingMode = thinkingMode;
    if (type === 'acp') {
      provider.command = command.trim();
      provider.args = splitArgs(args);
    }
    return provider;
  }

  useEffect(() => {
    if (dirtyRef.current) return;
    const next = value ?? { type: 'opencode' as const };
    setType(normalizeProviderType(next.type, acpEnabled));
    setModel(next.model ?? fallbackModel ?? '');
    setRuntimeMode(next.runtimeMode ?? '');
    setThinkingMode(next.thinkingMode ?? '');
    setCommand(next.command ?? '');
    setArgs((next.args ?? []).join(' '));
  }, [acpEnabled, value?.type, value?.model, value?.runtimeMode, value?.thinkingMode, value?.command, JSON.stringify(value?.args ?? []), fallbackModel]);

  useEffect(() => {
    if (!acpEnabled && type !== 'claude') {
      setType('claude');
      setModel('');
      setCustomModel('');
    }
  }, [acpEnabled, type]);

  useEffect(() => {
    const defaultModel = models.data?.defaultModel;
    if (!defaultModel) return;
    const available = models.data?.models ?? [];
    setModel((existing) => {
      if (!existing) return defaultModel;
      if (existing === '__custom__') return existing;
      if (available.some((m) => m.id === existing)) return existing;
      if (models.data?.allowCustom) {
        setCustomModel(existing);
        return '__custom__';
      }
      return defaultModel;
    });
  }, [models.data?.defaultModel, models.data?.allowCustom, JSON.stringify(models.data?.models ?? [])]);

  useEffect(() => {
    const modeOptions = runtimeOptions.data?.modeOptions ?? [];
    const thinkingOptions = runtimeOptions.data?.thinkingOptions ?? [];
    setRuntimeMode((existing) => {
      if (!modeOptions.length) return '';
      if (existing && modeOptions.some((option) => option.id === existing)) return existing;
      return modeOptions.find((option) => option.current)?.id ?? modeOptions[0].id;
    });
    setThinkingMode((existing) => {
      if (!thinkingOptions.length) return '';
      if (existing && thinkingOptions.some((option) => option.id === existing)) return existing;
      return thinkingOptions.find((option) => option.current)?.id ?? thinkingOptions[0].id;
    });
  }, [JSON.stringify(runtimeOptions.data?.modeOptions ?? []), JSON.stringify(runtimeOptions.data?.thinkingOptions ?? [])]);

  useEffect(() => {
    onChange?.(providerPayload());
  }, [type, model, customModel, runtimeMode, thinkingMode, command, args]);

  const providerOptions: Array<{ value: ProviderConfig['type']; label: string }> = acpEnabled
    ? [
      { value: 'opencode', label: 'OpenCode' },
      { value: 'gemini', label: 'Gemini CLI' },
      { value: 'codex', label: 'Codex ACP' },
      { value: 'claude', label: 'Claude Code' },
      { value: 'acp', label: 'Custom ACP' },
    ]
    : [{ value: 'claude', label: 'Claude Code' }];

  return (
    <div class="space-y-3">
      <EditorField label="Provider">
        <select
          value={type}
          onChange={(event) => {
            setType(normalizeProviderType((event.currentTarget as HTMLSelectElement).value as ProviderConfig['type'], acpEnabled));
            setModel('');
            setCustomModel('');
            markDirty();
          }}
          class="w-full h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-[12.5px] text-[var(--color-text)]"
        >
          {providerOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {!acpEnabled && (
          <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1">
            Provider selection is disabled. Set ENABLE_ACP=true to enable ACP providers.
          </div>
        )}
      </EditorField>

      <EditorField label="Model" hint="Saved with the provider. ACP providers receive it through session/set_model when supported.">
        <select
          value={model}
          onChange={(event) => { setModel((event.currentTarget as HTMLSelectElement).value); markDirty(); }}
          disabled={models.loading}
          class="w-full h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-[12.5px] text-[var(--color-text)] disabled:opacity-60"
        >
          {(models.data?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          {models.data?.allowCustom && <option value="__custom__">Custom model...</option>}
        </select>
        {model === '__custom__' && (
          <input
            type="text"
            value={customModel}
            onInput={(event) => { setCustomModel((event.currentTarget as HTMLInputElement).value); markDirty(); }}
            placeholder="model-id"
            class="mt-1.5 w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        )}
        {models.data?.note && <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1 leading-snug">{models.data.note}</div>}
      </EditorField>

      {(runtimeOptions.data?.modeOptions?.length ?? 0) > 0 && (
        <EditorField label="Agent speed">
          <SegmentedControl
            value={runtimeMode}
            options={(runtimeOptions.data?.modeOptions ?? []).map((option) => ({ value: option.id, label: option.label }))}
            onChange={(next) => { setRuntimeMode(next); markDirty(); }}
          />
        </EditorField>
      )}

      {(runtimeOptions.data?.thinkingOptions?.length ?? 0) > 0 && (
        <EditorField label="Thinking">
          <SegmentedControl
            value={thinkingMode}
            options={(runtimeOptions.data?.thinkingOptions ?? []).map((option) => ({ value: option.id, label: option.label }))}
            onChange={(next) => { setThinkingMode(next); markDirty(); }}
          />
        </EditorField>
      )}

      {runtimeOptions.loading && <div class="text-[11px] text-[var(--color-text-faint)]">Checking provider runtime options...</div>}
      {runtimeOptions.data?.source === 'fallback' && runtimeOptions.data.error && (
        <div class="text-[11px] text-[var(--color-text-faint)] leading-snug">Using fallback options: {runtimeOptions.data.error}</div>
      )}

      {type === 'acp' && (
        <>
          <EditorField label="Command">
            <input
              type="text"
              value={command}
              onInput={(event) => { setCommand((event.currentTarget as HTMLInputElement).value); markDirty(); }}
              placeholder="my-acp-agent"
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </EditorField>
          <EditorField label="Arguments" hint="Shell-style quoting is supported for simple args.">
            <input
              type="text"
              value={args}
              onInput={(event) => { setArgs((event.currentTarget as HTMLInputElement).value); markDirty(); }}
              placeholder="--acp"
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </EditorField>
        </>
      )}

      {onSave && (
        <div class="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => onSave(providerPayload())}
            disabled={busy}
            class="px-3 py-1.5 rounded-md text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? 'Saving...' : saveLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function EditorField({ label, hint, children }: { label: string; hint?: string; children: any }) {
  return (
    <div>
      <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">{label}</label>
      {children}
      {hint && <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1">{hint}</div>}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div class="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] p-0.5 flex-wrap">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            class={[
              'px-2.5 py-1 rounded text-[12px] font-medium transition-colors',
              active
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function splitArgs(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ''));
}
