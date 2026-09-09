/**
 * Copies text to the system clipboard, returning true only if it actually
 * landed there.
 *
 * `navigator.clipboard` exists only in a secure context — HTTPS or
 * localhost. A venue portal reached over plain `http://<ip>:3000` has no
 * `navigator.clipboard` at all, so the legacy `execCommand("copy")` path
 * below is the one that really runs in that deployment; it is the fix, not
 * a rare edge case. Callers should surface an error only on `false`.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Insecure context, denied permission, or a browser that rejects the
    // write outside a user gesture — fall through to the legacy path.
  }

  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false

  const textarea = document.createElement("textarea")
  textarea.value = text
  // Must stay rendered and selectable: `display:none` / `visibility:hidden`
  // make the selection — and therefore the copy — silently fail.
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.top = "0"
  textarea.style.left = "-9999px"
  document.body.appendChild(textarea)

  const previouslyFocused = document.activeElement as HTMLElement | null
  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    // Deprecated, but still the only clipboard write available without a
    // secure context, and supported by every browser this portal targets.
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea.remove()
    // Restore focus so a dialog's focus trap doesn't end up pointing at a
    // node that no longer exists.
    previouslyFocused?.focus?.()
  }
}
