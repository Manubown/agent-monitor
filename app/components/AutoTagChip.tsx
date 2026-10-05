import Link from "next/link";
import type { AutoTag } from "../../src/core/autotags";

/**
 * An automatic tag: dashed outline with a sparkle (styles in features.css), the rule's reason as tooltip.
 * Links to the sessions list filtered by the tag, like manual tags. Usable from server and client components.
 */
export function AutoTagChip({ tag, reason }: AutoTag) {
  return (
    <Link className="tag tag-auto" href={`/sessions?tag=${encodeURIComponent(tag)}`} title={`Automatic tag: ${reason}`}>
      {tag}
    </Link>
  );
}
