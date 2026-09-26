import { preload } from 'react-dom';
import { IMAGE_MANIFEST, type ImageSlug } from '@/allset/content/images.generated';

interface PhotoProps {
  readonly slug: ImageSlug;
  /** Describe what matters in the scene, not "image of". Empty only if purely decorative. */
  readonly alt: string;
  /** The layout width the image occupies, for the browser's source choice. */
  readonly sizes: string;
  /** The largest above-the-fold image: loaded eagerly, preloaded, high priority. */
  readonly priority?: boolean;
  readonly className?: string | undefined;
}

function srcset(slug: ImageSlug, format: 'avif' | 'webp'): string {
  return IMAGE_MANIFEST[slug].variants.map((v) => `/images/${slug}-${v.width}.${format} ${v.width}w`).join(', ');
}

/**
 * A responsive photograph: AVIF first, WebP fallback, intrinsic dimensions
 * always set so the browser reserves the space before a byte arrives (no
 * layout shift). Below-the-fold images are lazy.
 */
export function Photo({ slug, alt, sizes, priority = false, className }: PhotoProps) {
  const variants = IMAGE_MANIFEST[slug].variants;
  const largest = variants[variants.length - 1]!;
  const fallback = variants[Math.min(1, variants.length - 1)]!;

  if (priority) {
    preload(`/images/${slug}-${fallback.width}.avif`, {
      as: 'image',
      imageSrcSet: srcset(slug, 'avif'),
      imageSizes: sizes,
      type: 'image/avif',
      fetchPriority: 'high',
    });
  }

  return (
    <picture className={className}>
      <source type="image/avif" srcSet={srcset(slug, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={srcset(slug, 'webp')} sizes={sizes} />
      <img
        src={`/images/${slug}-${fallback.width}.webp`}
        alt={alt}
        width={largest.width}
        height={largest.height}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
        style={{ width: '100%', height: 'auto', aspectRatio: `${largest.width} / ${largest.height}` }}
      />
    </picture>
  );
}
