/**
 * Thin typed wrappers around the few @material/web components this screen uses.
 *
 * They are wrapped with `h()` instead of JSX so TypeScript never needs global `IntrinsicElements`
 * declarations for custom elements. Importing the component modules here (side effects) also
 * guarantees the custom elements are defined before Preact renders them.
 *
 * Why only buttons / text field / checkbox: the M3 *look* comes from the CSS tokens in styles.css
 * (see references/bonsai-ui/STYLE_GUIDE.md §3), not from this library. Plain semantic elements stay
 * native where they matter most for state (the item rows use `<ul>/<li>` with a native button
 * heading, and the paste box is a native `<textarea>` since Material Web has no multiline field).
 */

import { h } from "preact";
import type { RefObject } from "preact";

import "@material/web/button/filled-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/textfield/outlined-text-field.js";

export interface ActionButtonProps {
  label: string;
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
  /** Extra accessibility name when the visible label is an icon. */
  ariaLabel?: string;
}

export function FilledButton(props: ActionButtonProps) {
  return h(
    "md-filled-button",
    {
      type: "button",
      disabled: props.disabled,
      "aria-label": props.ariaLabel,
      onClick: props.onClick,
    },
    props.label,
  );
}

export function OutlinedButton(props: ActionButtonProps) {
  return h(
    "md-outlined-button",
    {
      type: "button",
      disabled: props.disabled,
      "aria-label": props.ariaLabel,
      onClick: props.onClick,
    },
    props.label,
  );
}

export function TextButton(props: ActionButtonProps) {
  return h(
    "md-text-button",
    {
      type: "button",
      disabled: props.disabled,
      "aria-label": props.ariaLabel,
      onClick: props.onClick,
    },
    props.label,
  );
}

export interface TickBoxProps {
  checked: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}

/**
 * `<md-checkbox>` is the one custom element binding a boolean property, so it is wrapped narrowly:
 * Preact sets `checked` on the host (property once upgraded, reflected attribute before that), and
 * listens to the host's bubbling `change` event.
 */
export function TickBox(props: TickBoxProps) {
  return h("md-checkbox", {
    checked: props.checked,
    disabled: props.disabled,
    "aria-label": props.label,
    onChange: props.onChange,
  });
}

/** `<md-outlined-text-field>` exposes `value` (not an attribute) — read it through a ref. */
export type TextFieldElement = HTMLElement & { value: string };

export interface TextFieldProps {
  label: string;
  fieldRef?: RefObject<TextFieldElement>;
  placeholder?: string;
  onEnter?: () => void;
  disabled?: boolean;
}

export function UrlField(props: TextFieldProps) {
  return h("md-outlined-text-field", {
    ref: props.fieldRef,
    label: props.label,
    placeholder: props.placeholder,
    disabled: props.disabled,
    type: "url",
    inputMode: "url",
    autocapitalize: "off",
    spellcheck: false,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        props.onEnter?.();
      }
    },
  });
}
