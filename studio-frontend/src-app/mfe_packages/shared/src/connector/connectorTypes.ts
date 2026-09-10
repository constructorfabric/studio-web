/**
 * Wire shapes of the studio-connector gear. Kept apart from any MFE's own
 * vocabulary: these are connections and repositories, not tenants.
 */

export interface ProviderDto {
  provider: string;
  display_name: string;
  default_base_url: string;
  instance_id: string;
  /** `source_code` | `ai` | `notification`. */
  category: string;
  credential_label: string;
  credential_hint: string;
  /**
   * `notification` providers only: the credential already fixes the channel
   * (an incoming webhook), so there is no channel to list and none to pick.
   */
  fixed_target: boolean;
}

export interface ProviderListDto {
  items: ProviderDto[];
}

/** A configured source host. `GET /connections`. */
export interface ConnectionDto {
  id: string;
  owner_tenant_id: string;
  provider: string;
  label: string;
  account: string;
  base_url: string;
  scope: string;
  secret_ref: string;
  created_at_epoch_secs: number;
}

export interface ConnectionListDto {
  items: ConnectionDto[];
}

/** The answer to both `POST /connections` and `POST /connections/{id}/test`. */
export interface ConnectionTestDto {
  connection: ConnectionDto;
  account: string;
  display_name?: string | null;
}

export interface CreateConnectionBody {
  provider: string;
  label: string;
  base_url?: string;
  token: string;
  scope: string;
  owner_tenant_id: string;
}

export interface RemoteRepoDto {
  id: string;
  name: string;
  full_path: string;
  clone_url: string;
  default_branch?: string | null;
  description?: string | null;
  visibility?: string | null;
}

export interface RemoteRepoListDto {
  items: RemoteRepoDto[];
}

/** A channel a notification connection can post to. `GET …/targets`. */
export interface NotifyTargetDto {
  /** Send this back as `target`; its shape differs per platform. */
  id: string;
  name: string;
  /** The server the channel belongs to, where the platform nests them. */
  container?: string | null;
  private: boolean;
  /** True for Zulip: a message to this target must carry a `topic`. */
  topic_required: boolean;
}

export interface NotifyTargetListDto {
  items: NotifyTargetDto[];
}

/** `POST …/messages`. Omit `target` for a `fixed_target` provider. */
export interface SendMessageBody {
  target?: string;
  text: string;
  title?: string;
  link?: string;
  topic?: string;
}

export interface SentMessageDto {
  connection_id: string;
  provider: string;
  /** Where it landed — not necessarily what was asked for. */
  target: string;
  message_id?: string | null;
}
