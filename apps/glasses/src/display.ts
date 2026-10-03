// Owns the two text containers. Created once; afterwards only the containers
// whose text changed are upgraded in place (flicker-free), debounced because
// the BLE render queue is slow.

import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { BridgeQueue } from './bridge-queue'
import { BODY, HEADER, PADDING } from './layout'
import type { Frame } from './render'

const RENDER_DEBOUNCE_MS = 120
// Firmware limits: 1000 chars at creation, 2000 per upgrade.
const CREATE_MAX = 1000
const UPGRADE_MAX = 2000

const HEADER_ID = 1
const HEADER_NAME = 'header'
const BODY_ID = 2
const BODY_NAME = 'body'

export class Display {
  private shown: Frame = { header: '', body: '' }
  private pending: Frame | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly queue: BridgeQueue,
    private readonly onError: (err: unknown) => void,
  ) {}

  async init(frame: Frame): Promise<void> {
    const container = (id: number, name: string, box: typeof HEADER | typeof BODY, content: string, capture: 0 | 1) =>
      new TextContainerProperty({
        xPosition: box.x,
        yPosition: box.y,
        width: box.w,
        height: box.h,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: PADDING,
        containerID: id,
        containerName: name,
        content: content.slice(0, CREATE_MAX) || ' ',
        // The body receives input: taps arrive as sysEvent, scrolls as textEvent.
        isEventCapture: capture,
      })
    const result = await this.queue.run('createStartUpPageContainer', () =>
      this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 2,
          textObject: [container(HEADER_ID, HEADER_NAME, HEADER, frame.header, 0), container(BODY_ID, BODY_NAME, BODY, frame.body, 1)],
        }),
      ),
    )
    if (result !== 0) throw new Error(`createStartUpPageContainer failed: ${result}`)
    this.shown = frame
  }

  show(frame: Frame): void {
    this.pending = frame
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, RENDER_DEBOUNCE_MS)
  }

  /** Re-sends everything, e.g. after the app returns to the foreground. */
  repaint(frame: Frame): void {
    this.shown = { header: '', body: '' }
    this.show(frame)
  }

  private async flush(): Promise<void> {
    const frame = this.pending
    this.pending = null
    if (!frame) return
    try {
      if (frame.header !== this.shown.header) await this.upgrade(HEADER_ID, HEADER_NAME, frame.header)
      if (frame.body !== this.shown.body) await this.upgrade(BODY_ID, BODY_NAME, frame.body)
      this.shown = frame
    } catch (err) {
      this.onError(err)
    }
  }

  private async upgrade(id: number, name: string, content: string): Promise<void> {
    const ok = await this.queue.run(`textContainerUpgrade ${name}`, () =>
      this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: id,
          containerName: name,
          contentOffset: 0,
          contentLength: 0,
          content: content.slice(0, UPGRADE_MAX) || ' ',
        }),
      ),
    )
    if (!ok) throw new Error(`textContainerUpgrade ${name} failed`)
  }
}
