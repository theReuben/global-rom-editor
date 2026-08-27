import { useEffect, useRef } from 'react'
import type { RenderedImage } from '../core/games/schema'

/**
 * A decoded sprite, drawn at whole-number scale so the pixels stay
 * square - a 24px icon shown at 25px would blur every edge.
 */
export function Sprite({
  image,
  scale = 1,
  title,
  className,
}: {
  image: RenderedImage | null
  scale?: number
  title?: string
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !image) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, image.width, image.height)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0)
  }, [image])
  if (!image) return null
  return (
    <canvas
      ref={ref}
      className={`pixel-sprite ${className ?? ''}`}
      title={title}
      style={{ width: image.width * scale, height: image.height * scale }}
    />
  )
}
