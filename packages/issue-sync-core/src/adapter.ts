export interface Issue {
  id: string;
  title: string;
  status: string;
  branchName?: string;
  url?: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  labels?: string[];
}

export interface TrackerAdapter {
  listIssues(states: string[]): Promise<Issue[]>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  transitionIssue(id: string, targetState: string): Promise<void>;
  commentIssue(id: string, body: string): Promise<void>;
}
