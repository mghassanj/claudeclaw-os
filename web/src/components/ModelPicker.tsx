import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronDown, Check } from 'lucide-preact';
import { useFetch } from '@/lib/useFetch';

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const PROVIDER_LABELS: Record<string, string> = {
  opencode: 'OpenCode default',
  gemini: 'Gemini CLI default',
  codex: 'Codex default',
  acp: 'ACP default',
};

interface ProviderStatus {
  providerType: 'claude' | 'opencode' | 'gemini' | 'codex' | 'acp';
  label: string;
  model: string;
}

interface Props {
  value: string;
  onSelect: (model: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function ModelPicker({ value, onSelect, disabled, size = 'sm' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const provider = useFetch<ProviderStatus>('/api/provider/status', 15_000);
  const providerType = provider.data?.providerType ?? 'claude';
  const isClaude = providerType === 'claude';

  const current = isClaude ? CLAUDE_MODELS.find((m) => m.id === value) : null;
  const displayLabel = isClaude
    ? (current?.label || value || 'default')
    : (PROVIDER_LABELS[providerType] || provider.data?.label || providerType);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const padCls = size === 'md' ? 'px-2.5 py-1.5 text-[12px]' : 'px-1.5 py-0.5 text-[10px]';

  // Non-Claude providers: show label only, no dropdown (model is managed by the provider CLI)
  if (!isClaude) {
    return (
      <div class="relative inline-block">
        <span
          class={[
            'inline-flex items-center gap-1 rounded font-medium border',
            padCls,
            'bg-[var(--color-elevated)] text-[var(--color-text-muted)] border-[var(--color-border)]',
          ].join(' ')}
          title="Model is managed by the provider. Switch providers in the sidebar."
        >
          {displayLabel}
        </span>
      </div>
    );
  }

  return (
    <div ref={ref} class="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        class={[
          'inline-flex items-center gap-1 rounded font-medium border transition-colors',
          padCls,
          disabled
            ? 'bg-[var(--color-elevated)] text-[var(--color-text-faint)] border-[var(--color-border)] cursor-not-allowed'
            : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
        ].join(' ')}
      >
        {displayLabel}
        {!disabled && <ChevronDown size={size === 'md' ? 12 : 10} />}
      </button>
      {open && (
        <div
          class="absolute top-full left-0 mt-1 z-30 bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg shadow-2xl overflow-hidden min-w-[140px]"
          onClick={(e) => e.stopPropagation()}
        >
          {CLAUDE_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onSelect(m.id); setOpen(false); }}
              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--color-elevated)] transition-colors"
            >
              <span class="text-[var(--color-text)]">{m.label}</span>
              {m.id === value && <Check size={12} class="ml-auto text-[var(--color-accent)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
