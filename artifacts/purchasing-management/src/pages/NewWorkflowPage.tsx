import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateWorkflow,
  useListDepartments,
  Priority,
} from "@/lib/api";

export function NewWorkflowPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: departments } = useListDepartments();
  const [title, setTitle] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [priority, setPriority] = useState<keyof typeof Priority>("NORMAL");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [neededBy, setNeededBy] = useState("");

  useEffect(() => {
    if (!departmentId && departments && departments.length > 0) {
      setDepartmentId(String(departments[0].id));
    }
  }, [departments, departmentId]);

  const create = useCreateWorkflow({
    mutation: {
      onSuccess: (wf) => {
        qc.invalidateQueries();
        setLocation(`/workflows/${wf.id}`);
      },
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !departmentId) return;
    create.mutate({
      data: {
        title,
        departmentId: Number(departmentId),
        priority,
        description: description || null,
        category: category || null,
        // Estimated amount removed by design — amount is now captured
        // per quote in the QUOTATION step, and the "3 quotes required"
        // rule is derived from the first quote.
        estimatedAmount: null,
        currency: null,
        neededBy: neededBy || null,
      },
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setLocation("/workflows")}
        data-testid="button-back"
      >
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>

      <Card>
        <CardHeader>
          <CardTitle data-testid="text-page-title">New workflow</CardTitle>
          <p className="text-sm text-muted-foreground">
            Start a new purchasing request. The workflow will start in NEW and
            advance to QUOTATION on creation.
          </p>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. New developer laptops"
                required
                data-testid="input-title"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Department *</Label>
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger data-testid="select-department">
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent>
                    {(departments ?? []).map((d) => (
                      <SelectItem key={d.id} value={String(d.id)}>
                        {d.name} ({d.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select
                  value={priority}
                  onValueChange={(v) => setPriority(v as keyof typeof Priority)}
                >
                  <SelectTrigger data-testid="select-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(Priority).map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="input-description"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Hardware"
                  data-testid="input-category"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="neededBy">Needed by</Label>
                <Input
                  id="neededBy"
                  type="date"
                  value={neededBy}
                  onChange={(e) => setNeededBy(e.target.value)}
                  data-testid="input-neededby"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={create.isPending}
                data-testid="button-submit"
              >
                {create.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Create workflow
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
