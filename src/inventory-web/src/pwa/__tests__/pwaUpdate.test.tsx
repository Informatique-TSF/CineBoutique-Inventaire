import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UpdateToast } from '../UpdateToast'
import { createPwaUpdateController, type PwaUpdateController } from '../pwaUpdateController'
import { pwaUpdateStore } from '../updateStore'

class FakeServiceWorkerContainer {
  readonly registration = { update: vi.fn(async () => undefined) } as unknown as ServiceWorkerRegistration
  private readonly listeners = new Set<() => void>()
  readonly getRegistration = vi.fn(async () => this.registration)

  addEventListener(_type: 'controllerchange', listener: () => void) {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'controllerchange', listener: () => void) {
    this.listeners.delete(listener)
  }

  emitControllerChange() {
    this.listeners.forEach((listener) => listener())
  }

  get updateMock() {
    return this.registration.update as unknown as ReturnType<typeof vi.fn>
  }
}

const createHarness = () => {
  let capturedOptions: RegisterSWOptions | undefined
  const updateSW = vi.fn<(reloadPage?: boolean) => Promise<void>>(async () => undefined)
  const registerSW = vi.fn((options?: RegisterSWOptions) => {
    capturedOptions = options
    return updateSW
  })
  const container = new FakeServiceWorkerContainer()
  const reload = vi.fn()
  const controller = createPwaUpdateController({
    registerSW,
    reload,
    serviceWorkerContainer: container,
    checkIntervalMs: 1_000,
    reloadDelayMs: 0,
  })

  const options = () => {
    if (!capturedOptions) {
      throw new Error('registerSW non appelé')
    }
    return capturedOptions
  }

  return { controller, registerSW, updateSW, container, reload, options }
}

let activeController: PwaUpdateController | null = null

describe('Mise à jour PWA sur confirmation', () => {
  beforeEach(() => {
    pwaUpdateStore.reset()
  })

  afterEach(() => {
    activeController?.dispose()
    activeController = null
    pwaUpdateStore.reset()
    vi.useRealTimers()
  })

  it('enregistre le service worker en mode immédiat et n’affiche rien sans nouvelle version', () => {
    const harness = createHarness()
    activeController = harness.controller

    render(<UpdateToast />)

    expect(harness.registerSW).toHaveBeenCalledTimes(1)
    expect(harness.options().immediate).toBe(true)
    expect(screen.queryByTestId('pwa-update-toast')).not.toBeInTheDocument()
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('affiche le bandeau quand une nouvelle version attend, sans recharger', () => {
    const harness = createHarness()
    activeController = harness.controller
    render(<UpdateToast />)

    act(() => {
      harness.options().onNeedRefresh?.()
    })

    const toast = screen.getByTestId('pwa-update-toast')
    expect(toast).toHaveTextContent('Nouvelle version disponible')
    expect(toast).toHaveAttribute('data-count-in-progress', 'false')
    expect(screen.queryByTestId('pwa-update-count-warning')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Plus tard' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mettre à jour' })).toHaveAttribute('data-default-action', 'true')
    expect(harness.reload).not.toHaveBeenCalled()
    expect(harness.updateSW).not.toHaveBeenCalled()

    // Un changement de contrôleur non sollicité ne recharge jamais la page.
    act(() => {
      harness.container.emitControllerChange()
    })
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('« Plus tard » masque le bandeau et ne déclenche ni mise à jour ni rechargement', async () => {
    const harness = createHarness()
    activeController = harness.controller
    render(<UpdateToast />)
    const user = userEvent.setup()

    act(() => {
      harness.options().onNeedRefresh?.()
    })
    await user.click(screen.getByTestId('pwa-update-later'))

    expect(screen.queryByTestId('pwa-update-toast')).not.toBeInTheDocument()
    expect(harness.updateSW).not.toHaveBeenCalled()
    expect(harness.reload).not.toHaveBeenCalled()
    expect(pwaUpdateStore.hasPendingUpdate()).toBe(true)
  })

  it('signale un comptage en cours et met « Plus tard » en avant', () => {
    const harness = createHarness()
    activeController = harness.controller
    render(<UpdateToast />)

    act(() => {
      pwaUpdateStore.setCountInProgress(true)
      harness.options().onNeedRefresh?.()
    })

    const toast = screen.getByTestId('pwa-update-toast')
    expect(toast).toHaveAttribute('data-count-in-progress', 'true')
    expect(screen.getByTestId('pwa-update-count-warning')).toHaveTextContent('Un comptage est en cours')
    expect(screen.getByTestId('pwa-update-later')).toHaveAttribute('data-default-action', 'true')
    expect(screen.getByTestId('pwa-update-apply')).toHaveAttribute('data-default-action', 'false')
    // Aucun vol de focus : la douchette doit continuer à écrire dans le champ de scan.
    expect(document.activeElement).toBe(document.body)
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('re-propose une mise à jour reportée pendant un comptage une fois celui-ci terminé', async () => {
    const harness = createHarness()
    activeController = harness.controller
    render(<UpdateToast />)
    const user = userEvent.setup()

    act(() => {
      pwaUpdateStore.setCountInProgress(true)
      harness.options().onNeedRefresh?.()
    })
    await user.click(screen.getByTestId('pwa-update-later'))
    expect(screen.queryByTestId('pwa-update-toast')).not.toBeInTheDocument()

    act(() => {
      pwaUpdateStore.setCountInProgress(false)
    })

    expect(screen.getByTestId('pwa-update-toast')).toHaveAttribute('data-count-in-progress', 'false')
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('« Mettre à jour » applique la mise à jour puis recharge au changement de contrôleur', async () => {
    const harness = createHarness()
    activeController = harness.controller
    render(<UpdateToast />)
    const user = userEvent.setup()

    act(() => {
      harness.options().onNeedRefresh?.()
    })
    await user.click(screen.getByTestId('pwa-update-apply'))

    expect(screen.queryByTestId('pwa-update-toast')).not.toBeInTheDocument()
    expect(harness.updateSW).toHaveBeenCalledTimes(1)
    expect(harness.updateSW).toHaveBeenCalledWith(true)
    expect(harness.reload).not.toHaveBeenCalled()

    act(() => {
      harness.container.emitControllerChange()
    })
    await waitFor(() => expect(harness.reload).toHaveBeenCalledTimes(1))
  })

  it('vérifie périodiquement et au retour au premier plan sans jamais recharger', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    activeController = harness.controller

    act(() => {
      harness.options().onRegisteredSW?.('/sw.js', harness.container.registration)
    })
    expect(harness.container.updateMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(harness.container.updateMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(harness.container.updateMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(harness.container.updateMock).toHaveBeenCalledTimes(5)
    expect(harness.reload).not.toHaveBeenCalled()
    expect(pwaUpdateStore.getSnapshot().updateAvailable).toBe(false)

    harness.controller.dispose()
    activeController = null
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(harness.container.updateMock).toHaveBeenCalledTimes(5)
  })
})
