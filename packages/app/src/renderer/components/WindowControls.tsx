/**
 * Window controls, drawn by the app.
 *
 * Windows' native overlay cannot be styled beyond two colours, so it always
 * read as a strip of someone else's chrome bolted to the title bar. Drawing
 * them means they match the rest of the surface — same hover, same radius, same
 * muted foreground — and the close button can go red on hover like every other
 * Windows app.
 *
 * macOS keeps its traffic lights; they are part of the platform's identity and
 * users expect them where they are.
 */
import * as React from "react";
import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function WindowControls({ platform }: { platform: string }): React.JSX.Element | null {
  const [maximized, setMaximized] = React.useState(false);

  React.useEffect(() => {
    if (platform !== "win32" && platform !== "linux") return;
    void window.luuCode.isWindowMaximized().then(setMaximized);
    return window.luuCode.onWindowStateChanged(setMaximized);
  }, [platform]);

  if (platform === "darwin") return null;

  return (
    <div className="no-drag ml-1 flex items-center self-stretch">
      <ControlButton label="Minimize" onClick={() => void window.luuCode.minimizeWindow()}>
        <Minus className="size-3.5" />
      </ControlButton>

      <ControlButton
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => void window.luuCode.toggleMaximizeWindow()}
      >
        {maximized ? (
          <span className="relative block size-3">
            <span className="absolute top-0 right-0 block size-2.5 rounded-[2px] border border-current" />
            <span className="absolute bottom-0 left-0 block size-2.5 rounded-[2px] border border-current bg-sidebar" />
          </span>
        ) : (
          <Square className="size-3" />
        )}
      </ControlButton>

      <ControlButton label="Close" onClick={() => void window.luuCode.closeWindow()} danger>
        <X className="size-3.5" />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-full w-[46px] place-items-center text-muted-foreground transition-colors",
        danger ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
