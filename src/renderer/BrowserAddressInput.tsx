import { Globe2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { browserAddressForCopy, browserAddressForNavigation, formatBrowserAddress } from '../shared/browser-address-display.js'

interface BrowserAddressInputProps {
  url: string
  className: string
  onNavigate(address: string): void | Promise<void>
}

/** Both browser surfaces share the same display, selection and editing behavior. */
export function BrowserAddressInput({ url, className, onNavigate }: BrowserAddressInputProps): React.JSX.Element {
  const [address, setAddress] = useState(() => formatBrowserAddress(url, { hideScheme: true }))
  const inputRef = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  const focusUrl = useRef(url)
  const compact = useRef(true)
  const edited = useRef(false)
  const composing = useRef(false)
  const selectOnPointerUp = useRef(false)

  useLayoutEffect(() => {
    if (focused.current) return
    focusUrl.current = url
    compact.current = true
    edited.current = false
    setAddress(formatBrowserAddress(url, { hideScheme: true }))
  }, [url])

  const expand = (preserveSelection: boolean): void => {
    const input = inputRef.current
    if (input === null || !compact.current || edited.current) return
    const shortAddress = formatBrowserAddress(focusUrl.current, { hideScheme: true })
    if (input.value !== shortAddress) return
    const fullAddress = formatBrowserAddress(focusUrl.current)
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? 0
    compact.current = false
    flushSync(() => setAddress(fullAddress))
    if (preserveSelection) {
      const prefix = fullAddress.length - shortAddress.length
      const allSelected = start === 0 && end === shortAddress.length
      input.setSelectionRange(allSelected ? 0 : start + prefix, end + prefix)
    }
  }

  const expandPartialEdit = (): void => {
    const input = inputRef.current
    if (input !== null && (input.selectionStart !== 0 || input.selectionEnd !== input.value.length)) expand(true)
  }

  return <form className={className} onSubmit={(event) => {
    event.preventDefault()
    if (composing.current) return
    const value = inputRef.current?.value ?? address
    if (value.trim().length > 0) void onNavigate(browserAddressForNavigation(value, focusUrl.current))
  }}>
    <Globe2 aria-hidden="true" />
    <input ref={inputRef} value={address} aria-label="网页地址" placeholder="输入网址或搜索内容" spellCheck={false}
      onFocus={(event) => {
        focused.current = true
        event.currentTarget.select()
      }}
      onBlur={() => {
        focused.current = false
        focusUrl.current = url
        compact.current = true
        edited.current = false
        composing.current = false
        selectOnPointerUp.current = false
        setAddress(formatBrowserAddress(url, { hideScheme: true }))
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        if (!focused.current) {
          // Native mouse selection would otherwise replace the initial select-all.
          event.preventDefault()
          selectOnPointerUp.current = true
          event.currentTarget.focus()
          event.currentTarget.select()
        } else {
          selectOnPointerUp.current = false
          expand(false)
        }
      }}
      onPointerUp={(event) => {
        if (!selectOnPointerUp.current) return
        selectOnPointerUp.current = false
        event.preventDefault()
        event.currentTarget.select()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) {
          event.preventDefault()
          return
        }
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) expand(true)
        else if (event.key === 'Backspace' || event.key === 'Delete') expandPartialEdit()
      }}
      onBeforeInput={expandPartialEdit}
      onPaste={expandPartialEdit}
      onCut={expandPartialEdit}
      onCompositionStart={() => { expandPartialEdit(); composing.current = true }}
      onCompositionEnd={() => { composing.current = false }}
      onChange={(event) => { edited.current = true; setAddress(event.currentTarget.value) }}
      onCopy={(event) => {
        const { value, selectionStart, selectionEnd } = event.currentTarget
        if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', browserAddressForCopy(value, focusUrl.current, selectionStart, selectionEnd))
      }}
    />
  </form>
}
