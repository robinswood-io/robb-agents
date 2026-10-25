import { mainLog } from "../logger";
import type { BrowserCDP } from '../browser-cdp.ts';
import type { ElementGeometry } from './shared.ts';

export async function typeText(transportOwner: BrowserCDP, text: string): Promise<void> {
    if (!text)
        return;
    const url = transportOwner["webContents"].getURL();
    const focused = await transportOwner["send"]('Runtime.evaluate', {
        expression: `(() => {
        let el = document.activeElement;
        for (let depth = 0; depth < 16; depth++) {
          if (el?.shadowRoot?.activeElement) { el = el.shadowRoot.activeElement; continue; }
          if (el && ['IFRAME','FRAME'].includes(el.tagName)) {
            // Preserve the existing CDP path for cross-origin frame editors.
            // The tool reports insertion requested, never verified application state.
            let child;
            try { child = el.contentDocument; } catch { return true; }
            if (!child) return true;
            el = child.activeElement;
            continue;
          }
          break;
        }
        if (!el || el.disabled || el.readOnly || el.getClientRects().length === 0) return false;
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return el.isContentEditable || el.tagName === 'TEXTAREA'
          || (el.tagName === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(el.type));
      })()`,
        returnByValue: true,
    });
    if (focused.exceptionDetails || focused.result?.value !== true || transportOwner["webContents"].getURL() !== url) {
        throw new Error('DOM typing requires a focused, visible editable field. For a canvas/remote desktop, focus its keyboard receiver and use type-keys explicitly; verify the remote text before submitting. No text was inserted.');
    }
    await transportOwner["send"]('Input.insertText', { text });
}

export async function typeKeys(transportOwner: BrowserCDP, text: string, isCurrent: () => boolean): Promise<void> {
    if (typeof text !== 'string' || !text || text.length > 256 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/.test(text) || /[\p{C}\p{Zl}\p{Zp}]/u.test(text)) {
        throw new Error('type-keys requires 1–256 printable BMP characters, without control characters or line breaks. Use a separate key command to submit only after verifying the remote text.');
    }
    const url = transportOwner["webContents"].getURL();
    const started = Date.now();
    let objectId: string | undefined;
    try {
        if (!isCurrent())
            throw new Error('Browser ownership changed');
        const target = await transportOwner["send"]('Runtime.evaluate', {
            expression: `(() => {
          let el = document.activeElement;
          while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
          if (!el || ['IFRAME','FRAME'].includes(el.tagName)) return null;
          return el;
        })()`,
        });
        objectId = target.result?.objectId;
        if (target.exceptionDetails || !objectId)
            throw new Error('Focused receiver unavailable');
        for (const key of text) {
            if (!isCurrent() || transportOwner["webContents"].getURL() !== url || Date.now() - started > 10000)
                throw new Error('Browser target changed or input deadline reached');
            const current = await transportOwner["send"]('Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: `function() {
            let el = document.activeElement;
            while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
            return document.hasFocus() && this.isConnected && this === el;
          }`,
                returnByValue: true,
            });
            if (current.exceptionDetails || current.result?.value !== true || !isCurrent() || transportOwner["webContents"].getURL() !== url)
                throw new Error('Focused receiver changed');
            try {
                await transportOwner["send"]('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key });
            }
            finally {
                // A failed/down or changed target must not leave a key held. Never replay it.
                await transportOwner["send"]('Input.dispatchKeyEvent', { type: 'keyUp', key });
            }
        }
    }
    catch {
        throw new Error('Keyboard text delivery stopped; input may be partial. Inspect the focused remote receiver before any retry; do not replay or submit the text blindly. Clipboard permissions were not changed.');
    }
    finally {
        if (objectId)
            await transportOwner["send"]('Runtime.releaseObject', { objectId }).catch(() => { });
    }
}

export async function setClipboard(transportOwner: BrowserCDP, text: string): Promise<void> {
    const result = await transportOwner["send"]('Runtime.evaluate', {
        expression: `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
    });
    if (result.exceptionDetails || result.result?.value !== true) {
        throw new Error('Clipboard write failed or was denied by browser policy. No paste shortcut was sent. Do not repeat this route or change permissions; use a focused DOM field or explicit type-keys for a remote keyboard receiver.');
    }
}

export async function getClipboard(transportOwner: BrowserCDP): Promise<string> {
    const result = await transportOwner["send"]('Runtime.evaluate', {
        expression: 'navigator.clipboard.readText()',
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
    });
    if (result.exceptionDetails || typeof result.result?.value !== 'string') {
        throw new Error('Clipboard read failed or was denied by browser policy; clipboard contents are unknown. Do not interpret this as an empty clipboard or change permissions.');
    }
    return result.result.value;
}

export async function clickElement(transportOwner: BrowserCDP, ref: string): Promise<ElementGeometry> {
    try {
        const resolved = await transportOwner["resolveElementRef"](ref);
        // Scroll element into view first
        await transportOwner["send"]('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            functionDeclaration: 'function() { this.scrollIntoViewIfNeeded(); }',
        });
        // Get element box model after scroll for up-to-date click coordinates
        const geometry = await transportOwner["getElementGeometry"](resolved.ref);
        const x = geometry.clickPoint.x;
        const y = geometry.clickPoint.y;
        // Use native input events for trusted mouse interaction
        await transportOwner["clickAtCoordinates"](x, y);
        return geometry;
    }
    catch (err) {
        mainLog.error(`[browser-cdp] Click failed for ${ref}:`, err);
        throw new Error(`Failed to click ${ref}: ${err}`);
    }
}

export async function fillElement(transportOwner: BrowserCDP, ref: string, value: string): Promise<ElementGeometry> {
    try {
        const resolved = await transportOwner["resolveElementRef"](ref);
        // Focus the element first
        await transportOwner["send"]('DOM.focus', { backendNodeId: resolved.backendNodeId });
        // Clear existing content
        await transportOwner["send"]('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            functionDeclaration: `function() {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }`,
        });
        // Insert the full value in one CDP round-trip while preserving input semantics.
        if (value) {
            await transportOwner["send"]('Input.insertText', { text: value });
        }
        // Dispatch change event
        await transportOwner["send"]('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            functionDeclaration: `function() {
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        });
        return await transportOwner["getElementGeometry"](resolved.ref);
    }
    catch (err) {
        mainLog.error(`[browser-cdp] Fill failed for ${ref}:`, err);
        throw new Error(`Failed to fill ${ref}: ${err}`);
    }
}

export async function selectOption(transportOwner: BrowserCDP, ref: string, value: string): Promise<ElementGeometry> {
    try {
        const resolved = await transportOwner["resolveElementRef"](ref);
        const result = await transportOwner["send"]('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            returnByValue: true,
            functionDeclaration: `function(val) {
          const normalize = (input) => String(input ?? '').trim().toLowerCase()
          const desired = normalize(val)

          const isVisible = (el) => {
            if (!el || !(el instanceof Element)) return false
            const style = window.getComputedStyle(el)
            if (!style) return false
            if (style.display === 'none' || style.visibility === 'hidden') return false
            if (Number(style.opacity || '1') === 0) return false
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          }

          const fireClick = (el) => {
            if (!el) return
            const events = [
              ['pointerdown', PointerEvent],
              ['mousedown', MouseEvent],
              ['pointerup', PointerEvent],
              ['mouseup', MouseEvent],
              ['click', MouseEvent],
            ]
            for (const [name, EventCtor] of events) {
              try {
                el.dispatchEvent(new EventCtor(name, { bubbles: true, cancelable: true, composed: true }))
              } catch {
                el.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }))
              }
            }
          }

          const readOptionValue = (el) => {
            if (!el || !(el instanceof Element)) return ''
            return (
              el.getAttribute('data-value')
              || el.getAttribute('value')
              || el.textContent
              || ''
            )
          }

          const hasDesired = (input) => normalize(input).includes(desired)

          const isNativeSelect = this instanceof HTMLSelectElement || String(this.tagName || '').toLowerCase() === 'select'
          if (isNativeSelect) {
            this.value = val
            this.dispatchEvent(new Event('input', { bubbles: true }))
            this.dispatchEvent(new Event('change', { bubbles: true }))

            const selected = this.selectedOptions && this.selectedOptions.length > 0 ? this.selectedOptions[0] : null
            const selectedValue = selected ? (selected.value || selected.textContent || '') : (this.value || '')
            const verified = hasDesired(selectedValue) || hasDesired(this.value)
            return {
              ok: verified,
              strategy: 'native',
              reason: verified ? undefined : 'native select value did not update as expected',
              selectedValue: this.value || '',
              selectedText: selected ? String(selected.textContent || '').trim() : '',
            }
          }

          this.focus && this.focus()
          fireClick(this)

          const candidateContainers = []
          const linkedIds = [this.getAttribute('aria-controls'), this.getAttribute('aria-owns')].filter(Boolean)
          for (const id of linkedIds) {
            const linked = document.getElementById(id)
            if (linked && isVisible(linked)) candidateContainers.push(linked)
          }

          const expandedCombos = Array.from(document.querySelectorAll('[role="combobox"][aria-expanded="true"]'))
          for (const combo of expandedCombos) {
            if (isVisible(combo) && combo !== this) candidateContainers.push(combo)
            const controls = combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns')
            if (controls) {
              const linked = document.getElementById(controls)
              if (linked && isVisible(linked)) candidateContainers.push(linked)
            }
          }

          for (const listbox of Array.from(document.querySelectorAll('[role="listbox"]'))) {
            if (isVisible(listbox)) candidateContainers.push(listbox)
          }

          const seen = new Set()
          const uniqueContainers = candidateContainers.filter((el) => {
            if (!el) return false
            if (seen.has(el)) return false
            seen.add(el)
            return true
          })

          const gatherOptions = (container) => {
            if (!container || !(container instanceof Element)) return []
            const options = Array.from(container.querySelectorAll('[role="option"], option, [data-value]'))
            return options.filter((opt) => isVisible(opt))
          }

          let options = []
          for (const container of uniqueContainers) {
            const local = gatherOptions(container)
            if (local.length > 0) {
              options = local
              break
            }
          }

          if (options.length === 0) {
            options = Array.from(document.querySelectorAll('[role="option"], option, [data-value]')).filter((opt) => isVisible(opt))
          }

          let matched = options.find((opt) => normalize(readOptionValue(opt)) === desired)
          if (!matched) matched = options.find((opt) => hasDesired(readOptionValue(opt)))

          if (!matched) {
            return {
              ok: false,
              strategy: 'aria',
              reason: 'option "' + val + '" not found in active listbox',
              selectedValue: '',
              selectedText: '',
            }
          }

          fireClick(matched)

          const selfValue = (
            this.value
            || this.getAttribute('value')
            || this.getAttribute('aria-valuetext')
            || this.getAttribute('aria-label')
            || this.textContent
            || ''
          )
          const matchedValue = readOptionValue(matched)
          const verified = hasDesired(selfValue) || hasDesired(matchedValue)

          return {
            ok: verified,
            strategy: 'aria',
            reason: verified ? undefined : 'option click succeeded but control state did not reflect selected value',
            selectedValue: String(selfValue || ''),
            selectedText: String(matchedValue || '').trim(),
          }
        }`,
            arguments: [{ value }],
        });
        const details = result?.result?.value as {
            ok?: boolean;
            strategy?: string;
            reason?: string;
            selectedValue?: string;
            selectedText?: string;
        } | undefined;
        if (details?.ok === false) {
            throw new Error([
                `Selection did not bind to form state`,
                details.strategy ? `strategy=${details.strategy}` : null,
                details.reason ? `reason=${details.reason}` : null,
                details.selectedValue ? `selectedValue=${details.selectedValue}` : null,
                details.selectedText ? `selectedText=${details.selectedText}` : null,
            ].filter(Boolean).join('; '));
        }
        return await transportOwner["getElementGeometry"](resolved.ref);
    }
    catch (err) {
        mainLog.error(`[browser-cdp] Select failed for ${ref}:`, err);
        throw new Error(`Failed to select option in ${ref}: ${err}`);
    }
}

export async function setFileInputFiles(transportOwner: BrowserCDP, ref: string, filePaths: string[]): Promise<ElementGeometry> {
    try {
        const resolved = await transportOwner["resolveElementRef"](ref);
        const inputObject = await transportOwner["send"]('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            functionDeclaration: `function() {
          const isFileInput = (el) => el instanceof HTMLInputElement && el.type === 'file';
          if (isFileInput(this)) return this;

          if (this instanceof HTMLLabelElement && isFileInput(this.control)) {
            return this.control;
          }

          const forAttr = this instanceof Element ? this.getAttribute('for') : null;
          if (forAttr) {
            const labelled = document.getElementById(forAttr);
            if (isFileInput(labelled)) return labelled;
          }

          if (this instanceof Element) {
            const nested = this.querySelector('input[type="file"]');
            if (isFileInput(nested)) return nested;

            let parent = this.parentElement;
            for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
              const nearby = parent.querySelector('input[type="file"]');
              if (isFileInput(nearby)) return nearby;
            }
          }

          const candidates = Array.from(document.querySelectorAll('input[type="file"]'));
          return candidates.length === 1 ? candidates[0] : null;
        }`,
        });
        const objectId = inputObject?.result?.objectId;
        if (!objectId) {
            throw new Error(`Element ${resolved.ref} is not a file input and no unambiguous file input was found nearby`);
        }
        await transportOwner["send"]('DOM.setFileInputFiles', {
            files: filePaths,
            objectId,
        });
        return await transportOwner["getElementGeometry"](resolved.ref);
    }
    catch (err) {
        mainLog.error(`[browser-cdp] setFileInputFiles failed for ${ref}:`, err);
        throw new Error(`Failed to set files on ${ref}: ${err}`);
    }
}
