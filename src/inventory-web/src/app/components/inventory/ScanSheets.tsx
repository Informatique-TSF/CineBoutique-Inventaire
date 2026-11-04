import { clsx } from 'clsx'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import type { InventoryItem, Product } from '../../types/inventory'

import { formatPieces } from './scanFormat'

/**
 * Fiches du scan caméra : elles montent du bas de l’écran (zone du pouce) par-dessus la caméra,
 * dont la lecture est suspendue tant qu’une fiche est ouverte.
 */

const QUICK_QUANTITIES = [1, 2, 3, 4, 5, 10] as const
const MAX_QUANTITY = 9999

const sanitizeQuantity = (value: string) => value.replace(/\D+/g, '').slice(0, 4)

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

const CheckIcon = ({ className = 'h-[18px] w-[18px]' }: { className?: string }) => (
  <svg {...iconProps} strokeWidth={2.6} className={className}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)

const AlertIcon = () => (
  <svg {...iconProps} strokeWidth={2.4} className="h-[18px] w-[18px]">
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
)

const CrossIcon = () => (
  <svg {...iconProps} strokeWidth={2.6} className="h-[18px] w-[18px]">
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
)

const PencilIcon = () => (
  <svg {...iconProps} strokeWidth={2.2} className="h-[18px] w-[18px]">
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </svg>
)

const ScanIcon = () => (
  <svg {...iconProps} strokeWidth={2.2} className="h-5 w-5">
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" />
  </svg>
)

export const ListIcon = () => (
  <svg {...iconProps} strokeWidth={2.2} className="h-5 w-5">
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </svg>
)

type StatusTone = 'success' | 'warning' | 'error' | 'edit'

const STATUS_TONES: Record<StatusTone, { badge: string; text: string; icon: ReactNode }> = {
  success: {
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    text: 'text-emerald-700 dark:text-emerald-300',
    icon: <CheckIcon />,
  },
  warning: {
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
    text: 'text-amber-800 dark:text-amber-200',
    icon: <AlertIcon />,
  },
  error: {
    badge: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
    text: 'text-rose-700 dark:text-rose-300',
    icon: <CrossIcon />,
  },
  edit: {
    badge: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200',
    text: 'text-brand-700 dark:text-brand-200',
    icon: <PencilIcon />,
  },
}

const StatusRow = ({ tone, children, id }: { tone: StatusTone; children: ReactNode; id?: string }) => (
  <div className="flex items-center gap-2.5">
    <span className={clsx('flex h-8 w-8 flex-none items-center justify-center rounded-full', STATUS_TONES[tone].badge)}>
      {STATUS_TONES[tone].icon}
    </span>
    <p id={id} className={clsx('text-[13px] font-semibold', STATUS_TONES[tone].text)}>
      {children}
    </p>
  </div>
)

const CodeChip = ({ children }: { children: ReactNode }) => (
  <span className="self-start rounded-lg bg-slate-100 px-2 py-1 font-mono text-[15px] font-semibold text-slate-900 dark:bg-slate-800 dark:text-white">
    {children}
  </span>
)

const primaryButtonClass =
  'flex h-[52px] items-center justify-center gap-2 rounded-2xl bg-brand-600 px-4 text-base font-bold text-white shadow-sm transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-slate-950'

const secondaryButtonClass =
  'flex h-[52px] items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 text-[15px] font-semibold text-slate-900 transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-white'

interface ScanSheetFrameProps {
  labelledBy: string
  children: ReactNode
  onEscape?: () => void
  testId?: string
  /** Fiche haute (liste) : occupe l’écran sous la barre du haut. */
  tall?: boolean
}

export const ScanSheetFrame = ({ labelledBy, children, onEscape, testId, tall = false }: ScanSheetFrameProps) => {
  // Échap ferme la fiche (clavier physique ou douchette en mode clavier).
  useEffect(() => {
    if (!onEscape) {
      return
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onEscape()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onEscape])

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40 bg-slate-950/55" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid={testId}
        className={clsx(
          'scan-sheet-enter fixed inset-x-0 bottom-0 z-[42] mx-auto flex w-full max-w-lg flex-col rounded-t-[28px] bg-white text-slate-900 shadow-[0_-20px_48px_-24px_rgba(0,0,0,0.6)] dark:bg-slate-950 dark:text-white',
          tall ? 'top-[max(4.5rem,10dvh)]' : 'max-h-[90dvh]',
        )}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
      >
        <span aria-hidden className="mx-auto mt-2.5 block h-1 w-10 flex-none rounded-full bg-slate-300 dark:bg-slate-700" />
        {children}
      </div>
    </>
  )
}

interface ScanLookupSheetProps {
  /** Code lu, ou `null` pendant l’analyse d’une photo. */
  code: string | null
  onCancel: () => void
}

export const ScanLookupSheet = ({ code, onCancel }: ScanLookupSheetProps) => {
  const titleId = useId()
  return (
    <ScanSheetFrame labelledBy={titleId} onEscape={onCancel} testId="scan-lookup-sheet">
      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 pt-3">
        <div className="flex items-center gap-2.5">
          <span className={clsx('flex h-8 w-8 flex-none items-center justify-center rounded-full', STATUS_TONES.success.badge)}>
            <CheckIcon />
          </span>
          <div className="min-w-0">
            <p id={titleId} className={clsx('text-[13px] font-semibold', STATUS_TONES.success.text)}>
              {code ? 'Code lu' : 'Photo reçue'}
            </p>
            {code && <p className="truncate font-mono text-[15px] font-semibold">{code}</p>}
          </div>
        </div>
        <div aria-hidden className="flex animate-pulse flex-col gap-2.5">
          <span className="block h-[18px] w-[86%] rounded-md bg-slate-200 dark:bg-slate-800" />
          <span className="block h-3.5 w-[48%] rounded-md bg-slate-100 dark:bg-slate-800/70" />
        </div>
        <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
          {code ? 'Recherche du produit…' : 'Analyse de la photo…'}
        </p>
        <button type="button" className={secondaryButtonClass} onClick={onCancel} data-testid="scan-lookup-cancel">
          Annuler
        </button>
      </div>
    </ScanSheetFrame>
  )
}

interface ScanErrorSheetProps {
  title: string
  message: string
  code?: string | null
  hint?: string
  onRetry: () => void
}

export const ScanErrorSheet = ({ title, message, code, hint, onRetry }: ScanErrorSheetProps) => {
  const titleId = useId()
  return (
    <ScanSheetFrame labelledBy={titleId} onEscape={onRetry} testId="scan-error-sheet">
      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 pt-3">
        <StatusRow tone="error" id={titleId}>
          {title}
        </StatusRow>
        <h2 className="text-[19px] font-bold leading-6">{message}</h2>
        {code && <CodeChip>{code}</CodeChip>}
        {hint && <p className="text-sm leading-5 text-slate-600 dark:text-slate-300">{hint}</p>}
        <button type="button" className={primaryButtonClass} onClick={onRetry} data-testid="scan-error-retry">
          <ScanIcon />
          Rescanner
        </button>
      </div>
    </ScanSheetFrame>
  )
}

interface ScanCountSheetProps {
  /** `count` : produit lu, quantité à ajouter ; `edit` : correction depuis la liste. */
  mode: 'count' | 'edit'
  product: Product
  /** Quantité déjà comptée dans la zone pour ce produit. */
  currentQuantity: number
  submitting?: boolean
  error?: string | null
  onConfirm: (quantity: number) => void
  onCancel: () => void
  onRemove?: () => void
}

export const ScanCountSheet = ({
  mode,
  product,
  currentQuantity,
  submitting = false,
  error,
  onConfirm,
  onCancel,
  onRemove,
}: ScanCountSheetProps) => {
  const titleId = useId()
  const inputId = useId()
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const [draft, setDraft] = useState(() => (mode === 'edit' ? String(Math.max(1, currentQuantity)) : '1'))
  const quantity = Number.parseInt(draft, 10) || 0
  const isEdit = mode === 'edit'
  const isDuplicate = !isEdit && currentQuantity > 0
  const canConfirm = quantity >= 1 && !submitting

  // Focus sur « Valider » : Entrée valide au clavier, et aucun clavier virtuel ne s’ouvre sur mobile.
  useEffect(() => {
    confirmRef.current?.focus({ preventScroll: true })
  }, [])

  const submit = () => {
    if (canConfirm) {
      onConfirm(Math.min(quantity, MAX_QUANTITY))
    }
  }

  const step = (delta: number) => {
    setDraft(String(Math.min(MAX_QUANTITY, Math.max(1, quantity + delta))))
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  let status: { tone: StatusTone; text: string } = { tone: 'success', text: 'Code lu · nouveau dans cette zone' }
  if (isEdit) {
    status = { tone: 'edit', text: 'Corriger la quantité comptée' }
  } else if (isDuplicate) {
    status = { tone: 'warning', text: `Déjà compté dans cette zone : ${formatPieces(currentQuantity)}` }
  }

  let confirmLabel = quantity >= 1 ? `Valider · ${formatPieces(quantity)}` : 'Valider'
  if (isEdit) {
    confirmLabel = 'Enregistrer'
  }
  if (submitting) {
    confirmLabel = 'Validation…'
  }

  const subGroup = product.subGroup?.trim()
  const sku = product.sku?.trim()

  return (
    <ScanSheetFrame labelledBy={titleId} onEscape={onCancel} testId="scan-count-sheet">
      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 pt-3">
        <StatusRow tone={status.tone}>{status.text}</StatusRow>
        <div className="flex flex-col gap-2">
          <h2 id={titleId} className="line-clamp-2 text-[19px] font-bold leading-6" title={product.name}>
            {product.name}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {sku && <CodeChip>{sku}</CodeChip>}
            <span className="font-mono text-xs text-slate-600 dark:text-slate-300">EAN {product.ean}</span>
            {subGroup && <span className="text-xs text-slate-600 dark:text-slate-300">Sous-groupe {subGroup}</span>}
          </div>
        </div>

        <div className="flex items-end justify-center gap-4">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Diminuer la quantité"
            className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-slate-100 text-slate-900 transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 dark:bg-slate-800 dark:text-white"
          >
            <svg {...iconProps} strokeWidth={2.4} className="h-6 w-6">
              <path d="M6 12h12" />
            </svg>
          </button>
          <div className="flex flex-col items-center gap-1">
            <label htmlFor={inputId} className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              {isDuplicate ? 'À ajouter' : 'Quantité'}
            </label>
            <input
              id={inputId}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={4}
              value={draft}
              onChange={(event) => setDraft(sanitizeQuantity(event.target.value))}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleInputKeyDown}
              data-testid="scan-sheet-quantity"
              className="h-[52px] w-24 rounded-2xl border-2 border-brand-200 bg-white text-center text-[28px] font-bold text-slate-900 focus-visible:border-brand-500 focus-visible:outline-none dark:border-brand-500/40 dark:bg-slate-900 dark:text-white"
            />
          </div>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Augmenter la quantité"
            className="flex h-14 w-14 flex-none items-center justify-center rounded-full bg-brand-600 text-white transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            <svg {...iconProps} strokeWidth={2.4} className="h-6 w-6">
              <path d="M12 6v12M6 12h12" />
            </svg>
          </button>
        </div>

        <div role="group" aria-label="Quantités rapides" className="grid grid-cols-6 gap-2">
          {QUICK_QUANTITIES.map((value) => {
            const selected = quantity === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setDraft(String(value))}
                aria-pressed={selected}
                aria-label={formatPieces(value)}
                className={clsx(
                  'h-11 rounded-xl border text-base font-semibold transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300',
                  selected
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white',
                )}
              >
                {value}
              </button>
            )
          })}
        </div>

        {isDuplicate && (
          <p className="text-center text-[13px] font-semibold text-slate-600 dark:text-slate-300" data-testid="scan-sheet-total">
            Total dans la zone : {currentQuantity} → {currentQuantity + quantity}
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm font-semibold text-rose-600 dark:text-rose-300">
            {error}
          </p>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2.5">
          <button type="button" className={secondaryButtonClass} onClick={onCancel} data-testid="scan-sheet-cancel">
            Annuler
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={primaryButtonClass}
            onClick={submit}
            disabled={!canConfirm}
            data-testid="scan-sheet-confirm"
          >
            <CheckIcon className="h-5 w-5" />
            {confirmLabel}
          </button>
        </div>

        {isEdit && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="h-11 self-center rounded-xl px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 dark:text-rose-300 dark:hover:bg-rose-500/10"
            data-testid="scan-sheet-remove"
          >
            Retirer de la liste
          </button>
        )}
      </div>
    </ScanSheetFrame>
  )
}

interface ScanItemsSheetProps {
  shopName: string
  locationLabel: string
  summary: string
  items: InventoryItem[]
  onEdit: (ean: string) => void
  onClose: () => void
}

export const ScanItemsSheet = ({ shopName, locationLabel, summary, items, onEdit, onClose }: ScanItemsSheetProps) => {
  const titleId = useId()
  return (
    <ScanSheetFrame labelledBy={titleId} onEscape={onClose} testId="scan-items-sheet" tall>
      <div className="flex flex-none flex-col gap-0.5 border-b border-slate-200 px-5 pb-3 pt-3 dark:border-slate-800">
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{shopName}</p>
        <h2 id={titleId} className="truncate text-lg font-bold">
          {locationLabel}
        </h2>
        <p className="text-[13px] text-slate-600 dark:text-slate-300">
          {summary}
          {items.length > 0 && ' · touchez une ligne pour corriger'}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-slate-600 dark:text-slate-300">
            Aucun article compté pour l’instant. Scannez un code-barres pour commencer.
          </p>
        ) : (
          <ul>
            {items.map((item) => {
              const sku = item.product.sku?.trim()
              return (
                <li key={item.id} data-testid="scanned-row" data-ean={item.product.ean}>
                  <button
                    type="button"
                    onClick={() => onEdit(item.product.ean)}
                    aria-label={`Corriger ${item.product.name}, quantité ${item.quantity}`}
                    className="flex min-h-[60px] w-full items-center gap-3 border-b border-slate-100 px-2 py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300 dark:border-slate-800 dark:hover:bg-slate-900"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[15px] font-semibold">{item.product.name}</span>
                      <span className="truncate font-mono text-xs text-slate-600 dark:text-slate-300">
                        {sku ? `${sku} · EAN ${item.product.ean}` : `EAN ${item.product.ean}`}
                      </span>
                    </span>
                    {item.hasConflict && (
                      <span className="flex-none rounded-full bg-rose-100 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:bg-rose-500/10 dark:text-rose-200">
                        Conflit
                      </span>
                    )}
                    <span className="flex h-8 min-w-10 flex-none items-center justify-center rounded-full bg-brand-50 px-2.5 text-[15px] font-bold text-brand-700 dark:bg-brand-500/15 dark:text-brand-200">
                      {item.quantity}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="flex-none border-t border-slate-200 px-5 pt-3 dark:border-slate-800">
        <button type="button" className={clsx(primaryButtonClass, 'w-full')} onClick={onClose} data-testid="scan-items-close">
          <ScanIcon />
          Reprendre le scan
        </button>
      </div>
    </ScanSheetFrame>
  )
}

interface ScanUndoToastProps {
  title: string
  detail: string
  onUndo: () => void
}

export const ScanUndoToast = ({ title, detail, onUndo }: ScanUndoToastProps) => (
  <div
    role="status"
    data-testid="scan-undo-toast"
    className="absolute inset-x-3 bottom-3 z-30 flex items-center gap-2.5 rounded-2xl bg-slate-900/95 py-2.5 pl-3 pr-1.5 text-white shadow-xl backdrop-blur"
  >
    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-emerald-600 text-white">
      <CheckIcon />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="truncate text-sm font-semibold">{title}</span>
      <span className="truncate text-xs text-slate-300">{detail}</span>
    </span>
    <button
      type="button"
      onClick={onUndo}
      className="h-11 flex-none rounded-xl px-3 text-sm font-semibold text-brand-300 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
      data-testid="scan-undo"
    >
      Annuler
    </button>
  </div>
)
