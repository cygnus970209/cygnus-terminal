import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./Select.css";

type Option = {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
};
type Props = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children"
> & {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
};
function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : String(child),
    )
    .join("");
}
function readOptions(
  children: ReactNode,
  group?: string,
  disabled = false,
): Option[] {
  return Children.toArray(children).flatMap((child): Option[] => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string;
        label?: string;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === Fragment)
      return readOptions(child.props.children, group, disabled);
    if (child.type === "optgroup")
      return readOptions(
        child.props.children,
        child.props.label,
        disabled || !!child.props.disabled,
      );
    if (child.type !== "option") return [];
    const label = child.props.label ?? plainText(child.props.children);
    return [
      {
        value: child.props.value ?? label,
        label,
        group,
        disabled: disabled || !!child.props.disabled,
      },
    ];
  });
}

export default function Select({
  value,
  onValueChange,
  children,
  className = "",
  disabled,
  ...props
}: Props) {
  const options = readOptions(children);
  const selected = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 280,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const listId = useId();
  const show = () => {
    if (trigger.current?.matches(":disabled")) return;
    setActive(
      selected >= 0 && !options[selected].disabled
        ? selected
        : options.findIndex((o) => !o.disabled),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    if (
      !options[index] ||
      options[index].disabled ||
      trigger.current?.matches(":disabled")
    )
      return;
    setOpen(false);
    trigger.current?.focus();
    onValueChange(options[index].value);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 240 && above > below;
      const maxHeight = Math.max(40, Math.min(280, upwards ? above : below));
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
      if (menu.current) menu.current.style.width = `${width}px`;
      const height = Math.min(
        (menu.current?.scrollHeight ?? maxHeight) + 2,
        maxHeight,
      );
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? rect.top - height - 6 : rect.bottom + 6,
        width,
        maxHeight,
      });
    };
    place();
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  return (
    <>
      <button
        {...props}
        ref={trigger}
        type="button"
        disabled={disabled}
        className={`custom-select ${className}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${listId}-${active}` : undefined
        }
        onBlur={() => setOpen(false)}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (event.key === "Tab") {
            setOpen(false);
            return;
          }
          if (
            ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!open) {
              show();
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              choose(active);
              return;
            }
            const enabled = options
              .map((o, i) => (o.disabled ? -1 : i))
              .filter((i) => i >= 0);
            const current = enabled.indexOf(active);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? enabled.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      enabled.length) %
                    enabled.length;
            setActive(enabled[next] ?? -1);
          } else if (
            event.key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const now = Date.now();
            search.current.text =
              (now - search.current.time > 700 ? "" : search.current.text) +
              event.key.toLocaleLowerCase();
            search.current.time = now;
            const index = options.findIndex(
              (o) =>
                !o.disabled &&
                o.label.toLocaleLowerCase().startsWith(search.current.text),
            );
            if (!open) show();
            if (index >= 0) setActive(index);
          }
        }}
      >
        <span className="custom-select-value">
          {options[selected]?.label ?? "Select…"}
        </span>
        <svg
          className="custom-select-chevron"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={props["aria-label"] ?? "Options"}
            className="custom-select-menu"
            style={position}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {options.map((option, index) => (
              <Fragment key={`${option.value}-${index}`}>
                {option.group && option.group !== options[index - 1]?.group && (
                  <div className="custom-select-group">{option.group}</div>
                )}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={value === option.value}
                  aria-disabled={option.disabled || undefined}
                  data-index={index}
                  data-active={active === index}
                  className="custom-select-option"
                  onPointerMove={() => {
                    if (!option.disabled) setActive(index);
                  }}
                  onClick={() => choose(index)}
                >
                  <span>{option.label}</span>
                  <span aria-hidden="true">
                    {value === option.value ? "✓" : ""}
                  </span>
                </div>
              </Fragment>
            ))}
            {!options.length && (
              <div className="custom-select-group">No options</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
