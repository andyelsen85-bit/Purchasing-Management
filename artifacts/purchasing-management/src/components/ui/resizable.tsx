"use client"

import { GripVertical } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

/**
 * Persist panel sizes in `localStorage` instead of the library default
 * (`sessionStorage`). sessionStorage is scoped to a single tab and is
 * cleared whenever the browser is fully closed; users expect the
 * sidebar widths to survive reloads, new tabs, and restarts. We expose
 * a thin shim matching the library's `PanelGroupStorage` shape so the
 * persisted JSON keeps the same `panel-group:<autoSaveId>` keys it
 * already used — no migration required.
 */
const localStorageBacking: ResizablePrimitive.PanelGroupStorage | undefined =
  typeof window !== "undefined"
    ? {
        getItem(name: string): string | null {
          try {
            return window.localStorage.getItem(name);
          } catch {
            return null;
          }
        },
        setItem(name: string, value: string): void {
          try {
            window.localStorage.setItem(name, value);
          } catch {
            /* quota / privacy mode — silently ignore */
          }
        },
      }
    : undefined;

const ResizablePanelGroup = ({
  className,
  storage,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) => (
  <ResizablePrimitive.PanelGroup
    storage={storage ?? localStorageBacking}
    className={cn(
      "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
      className
    )}
    {...props}
  />
)

const ResizablePanel = ResizablePrimitive.Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) => (
  <ResizablePrimitive.PanelResizeHandle
    className={cn(
      "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 [&[data-panel-group-direction=vertical]>div]:rotate-90",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </ResizablePrimitive.PanelResizeHandle>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
