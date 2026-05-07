import * as React from "react"
import { CalendarIcon } from "lucide-react"
import { fr } from "date-fns/locale"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

function parseIso(s: string): Date | undefined {
  if (!s) return undefined
  const [y, m, d] = s.split("-").map(Number)
  if (!y || !m || !d) return undefined
  const date = new Date(y, m - 1, d)
  return isNaN(date.getTime()) ? undefined : date
}

function toIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function formatFr(d: Date): string {
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  "data-testid"?: string
}

export function DatePicker({
  value,
  onChange,
  disabled,
  placeholder = "jj/mm/aaaa",
  className,
  "data-testid": testId,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const selected = parseIso(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          data-testid={testId}
          className={cn(
            "w-full justify-start text-left font-normal",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          {selected ? formatFr(selected) : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            onChange(date ? toIso(date) : "")
            setOpen(false)
          }}
          locale={fr}
          captionLayout="dropdown"
          defaultMonth={selected ?? new Date()}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  )
}
