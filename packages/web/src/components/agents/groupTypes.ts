export interface GroupMemberInfo {
  id: string;
  name: string;
  emoji: string;
}

export interface GroupChat {
  id: string;
  name: string;
  createdAt: string;
  memberIds: string[];
  members?: GroupMemberInfo[];
}

export interface GroupMessage {
  id: string;
  groupId: string;
  author: string;
  text: string;
  createdAt: string;
  handoffTo: string | null;
  handoffNote: string | null;
}
