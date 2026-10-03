// Draws Scenes on the glasses. The page is created once; afterwards:
//   - same layout (container ids, boxes, borders): flicker-free
//     textContainerUpgrade of only the containers whose text or brightness changed
//   - different layout (an overlay opened, closed, or resized): one
//     rebuildPageContainer, which flickers briefly on hardware
// Updates are debounced because the BLE render queue is slow.

import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { BridgeQueue } from './bridge-queue'
import type { ContainerSpec, Scene } from './render'

const RENDER_DEBOUNCE_MS = 100
// Firmware limits: 1000 chars at creation or rebuild, 2000 per upgrade.
const CREATE_MAX = 1000
const UPGRADE_MAX = 2000
const BORDER_COLOR = 12

/** Everything except text and brightness: a change here needs a rebuild. */
export function layoutKey(scene: Scene): string {
  return JSON.stringify([scene.containers.map(c => [c.id, c.name, c.box, c.capture, c.z]), scene.menu])
}

/** The OS side menu travels with the page; a rebuild without it would clear it. */
function menuObject(scene: Scene): { menuObject?: MenuContainerProperty } {
  if (!scene.menu.length) return {}
  return { menuObject: new MenuContainerProperty({ menuItems: scene.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.label })) }) }
}

function property(c: ContainerSpec): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: c.box.x,
    yPosition: c.box.y,
    width: c.box.w,
    height: c.box.h,
    borderWidth: c.box.border,
    borderColor: BORDER_COLOR,
    borderRadius: c.box.radius,
    paddingLength: c.box.padding,
    containerID: c.id,
    containerName: c.name,
    content: c.content.slice(0, CREATE_MAX) || ' ',
    textColor: c.brightness,
    isEventCapture: c.capture ? 1 : 0,
    // All-or-nothing per page: every container sets a unique zOrderIndex.
    zOrderIndex: c.z,
  })
}

export class Display {
  private shown: Scene = { containers: [], menu: [] }
  private pending: Scene | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly queue: BridgeQueue,
    private readonly onError: (err: unknown) => void,
  ) {}

  async init(scene: Scene): Promise<void> {
    const result = await this.queue.run('createStartUpPageContainer', () =>
      this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: scene.containers.length, textObject: scene.containers.map(property), ...menuObject(scene) }),
      ),
    )
    // Creation is allowed once per app run. After a WebView reload the page
    // already exists and creation fails, so rebuild it instead.
    if (result !== 0) await this.rebuild(scene)
    this.shown = scene
  }

  show(scene: Scene): void {
    this.pending = scene
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, RENDER_DEBOUNCE_MS)
  }

  /** Redraws everything, e.g. after the app returns to the foreground. */
  repaint(scene: Scene): void {
    this.shown = { containers: [], menu: [] }
    this.show(scene)
  }

  private async flush(): Promise<void> {
    const scene = this.pending
    this.pending = null
    if (!scene) return
    try {
      if (layoutKey(scene) !== layoutKey(this.shown)) {
        await this.rebuild(scene)
      } else {
        for (const c of scene.containers) {
          const before = this.shown.containers.find(p => p.id === c.id)
          if (before?.content !== c.content || before.brightness !== c.brightness) await this.upgrade(c)
        }
      }
      this.shown = scene
    } catch (err) {
      this.onError(err)
    }
  }

  private async rebuild(scene: Scene): Promise<void> {
    const ok = await this.queue.run('rebuildPageContainer', () =>
      this.bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: scene.containers.length, textObject: scene.containers.map(property), ...menuObject(scene) }),
      ),
    )
    if (!ok) throw new Error('rebuildPageContainer failed')
  }

  private async upgrade(c: ContainerSpec): Promise<void> {
    const ok = await this.queue.run(`textContainerUpgrade ${c.name}`, () =>
      this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: c.id,
          containerName: c.name,
          contentOffset: 0,
          contentLength: 0,
          content: c.content.slice(0, UPGRADE_MAX) || ' ',
          textColor: c.brightness,
        }),
      ),
    )
    if (!ok) throw new Error(`textContainerUpgrade ${c.name} failed`)
  }
}
