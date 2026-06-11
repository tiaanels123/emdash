import React from 'react';
import { Input } from '@renderer/lib/ui/input';

interface Props {
  organization: string;
  pat: string;
  project: string;
  onChange: (update: Partial<{ organization: string; pat: string; project: string }>) => void;
  error?: string | null;
}

const AzureDevOpsSetupForm: React.FC<Props> = ({ organization, pat, project, onChange, error }) => {
  return (
    <div className="grid gap-2">
      <Input
        placeholder="Organization (e.g. qala) or full URL"
        value={organization}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          onChange({ organization: e.target.value })
        }
        className="h-9 w-full"
        autoFocus
      />
      <Input
        type="password"
        placeholder="Personal access token"
        value={pat}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ pat: e.target.value })}
        className="h-9 w-full"
      />
      <Input
        placeholder="Project (optional, e.g. Qala)"
        value={project}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ project: e.target.value })}
        className="h-9 w-full"
      />
      <p className="text-muted-foreground text-xs">
        Create a token under <span className="font-medium">dev.azure.com → User settings →</span>{' '}
        <span className="font-medium">Personal access tokens</span> with the{' '}
        <span className="font-medium">Work Items (Read)</span> scope. Leave Project blank to see
        work items across the whole organization.
      </p>
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default AzureDevOpsSetupForm;
