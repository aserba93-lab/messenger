export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum NotificationPreferenceMode {
    all
    mentions
    none
  }

  enum OrgRole {
    owner
    admin
    manager
    employee
    guest
  }

  enum InviteStatus {
    active
    accepted
    revoked
    expired
  }

  enum PresenceStatus {
    online
    offline
    away
    dnd
  }

  enum ChannelType {
    public
    private
    broadcast
  }

  enum WorkspaceRole {
    admin
    member
    observer
  }

  enum MessageType {
    text
    file
    voice
    system
  }

  type Query {
    health: String!
    organization(organizationId: ID!): Organization!
    users(organizationId: ID!, role: OrgRole, department: String, status: PresenceStatus): [User!]!
    organizationInvites(organizationId: ID!, role: OrgRole, status: InviteStatus, query: String, limit: Int = 50, offset: Int = 0): [Invite!]!
    me: User
    user(id: ID!, organizationId: ID!): User

    workspaces: [Workspace!]!
    workspaceMembers(workspaceId: ID!): [WorkspaceMember!]!
    channels(workspaceId: ID!): [Channel!]!
    channelMembers(channelId: ID!): [User!]!

    messages(channelId: ID!, cursor: ID, limit: Int = 50): MessageConnection!
    thread(parentMessageId: ID!, limit: Int = 50): [Message!]!
    searchMessages(
      query: String!
      limit: Int = 50
      channelId: ID
      groupChatId: ID
      directChatId: ID
    ): [Message!]!
    threadReadStates(channelId: ID, groupChatId: ID, directChatId: ID): [ThreadReadStateEntry!]!
    messageReaders(messageId: ID!): [User!]!
    pinnedMessages(channelId: ID, groupChatId: ID, directChatId: ID, limit: Int = 10): [Message!]!
    savedMessages(limit: Int = 50): [Message!]!
    savedMessageIds(limit: Int = 200): [ID!]!

    # DMs / group chats
    dms: [DirectChat!]!
    directChatMessages(directChatId: ID!, limit: Int = 50): [DirectChatMessage!]!
    groupChats: [GroupChat!]!
    groupChatMessages(groupChatId: ID!, limit: Int = 50): [Message!]!

    # Module 5 stubs
    notifications(limit: Int = 50): [Notification!]!
    notificationPreference(channelId: ID, groupChatId: ID, directChatId: ID): NotificationPreference
    globalSearch(query: String!): GlobalSearchResult!

    file(id: ID!): File!
  }

  type Mutation {
    registerOrganization(input: RegisterOrganizationInput!): RegisterOrganizationPayload!
    login(input: LoginInput!): LoginPayload!
    acceptInvite(input: AcceptInviteInput!): LoginPayload!
    logout: Boolean!
    refresh(input: RefreshInput!): LoginPayload!

    requestEmailVerification: EmailVerificationRequestPayload!
    verifyEmail(input: VerifyEmailInput!): Boolean!

    twoFaSetup: TwoFaSetupPayload!
    twoFaVerify(code: String!): TwoFaVerifyPayload!

    updateUser(input: UpdateUserInput!): User!
    inviteUser(input: InviteUserInput!): Invite!
    createOrganizationUser(input: CreateOrganizationUserInput!): User!
    setUserPassword(input: SetUserPasswordInput!): Boolean!
    revokeInvite(input: RevokeInviteInput!): Boolean!
    deactivateUser(input: DeactivateUserInput!): Boolean!
    setUserRole(input: SetUserRoleInput!): User!

    updateOrganizationSettings(input: UpdateOrganizationSettingsInput!): Organization!

    createWorkspace(input: CreateWorkspaceInput!): Workspace!
    updateWorkspace(input: UpdateWorkspaceInput!): Workspace!
    archiveWorkspace(input: ArchiveWorkspaceInput!): Boolean!
    deleteWorkspace(input: DeleteWorkspaceInput!): Boolean!
    workspaceAddMember(input: WorkspaceAddMemberInput!): WorkspaceMember!
    workspaceRemoveMember(input: WorkspaceRemoveMemberInput!): Boolean!

    createChannel(input: CreateChannelInput!): Channel!
    channelAddMember(input: ChannelAddMemberInput!): Boolean!
    channelRemoveMember(input: ChannelRemoveMemberInput!): Boolean!
    archiveChannel(input: ArchiveChannelInput!): Boolean!
    deleteChannel(input: DeleteChannelInput!): Boolean!
    updateChannel(input: UpdateChannelInput!): Channel!

    sendMessage(input: SendMessageInput!): Message!
    sendFileMessage(input: SendFileMessageInput!): Message!
    editMessage(input: EditMessageInput!): Message!
    deleteMessage(input: DeleteMessageInput!): Boolean!
    toggleReaction(input: ToggleReactionInput!): [Reaction!]!

    markThreadRead(input: MarkThreadReadInput!): Boolean!

    forwardMessages(input: ForwardMessagesInput!): Boolean!
    pinMessage(input: PinMessageInput!): Boolean!
    unpinMessage(input: UnpinMessageInput!): Boolean!
    saveMessage(messageId: ID!): Boolean!
    unsaveMessage(messageId: ID!): Boolean!

    # DMs / group chats
    ensureDirectChat(userId: ID!): DirectChat!
    sendDirectMessage(input: SendDirectMessageInput!): DirectChatMessage!
    sendDirectFileMessage(input: SendDirectFileMessageInput!): DirectChatMessage!
    editDirectMessage(directChatId: ID!, messageId: ID!, content: String!): DirectChatMessage!
    deleteDirectMessage(directChatId: ID!, messageId: ID!): Boolean!
    createGroupChat(input: CreateGroupChatInput!): GroupChat!
    sendGroupChatMessage(input: SendGroupChatMessageInput!): Message!
    sendGroupChatFileMessage(input: SendGroupChatFileMessageInput!): Message!
    editGroupChatMessage(groupChatId: ID!, messageId: ID!, content: String!): Message!
    deleteGroupChatMessage(groupChatId: ID!, messageId: ID!): Boolean!
    updateGroupChat(input: UpdateGroupChatInput!): GroupChat!
    groupChatAddMembers(input: GroupChatAddMembersInput!): GroupChat!

    # Module 5 stubs
    uploadFileStub: Boolean!
    markNotificationRead(notificationId: ID!): Boolean!
    setNotificationPreference(input: SetNotificationPreferenceInput!): NotificationPreference!
    startCallStub: Boolean!
    adminExportStub: Boolean!

    createPresignedUpload(input: CreatePresignedUploadInput!): PresignedUpload!
    uploadFileBase64(fileId: ID!, base64: String!, mimeType: String): Boolean!
    confirmFileUploaded(fileId: ID!): Boolean!
    markFileScanned(input: MarkFileScannedInput!): Boolean!
  }

  input RegisterOrganizationInput {
    organizationName: String!
    email: String!
    password: String!
    domain: String
    firstName: String
    lastName: String
  }

  enum SystemAccessLevel {
    platform
    organization
    basic
  }

  input LoginInput {
    email: String
    identifier: String
    password: String!
    organizationId: ID!
    twoFactorCode: String
    backupCode: String
  }

  input RefreshInput {
    organizationId: ID!
  }

  type Viewer {
    userId: ID!
    organizationId: ID!
    role: OrgRole!
    systemAccessLevel: SystemAccessLevel!
  }

  type ThreadReadStateEntry {
    userId: ID!
    lastReadAt: DateTime!
  }

  input MarkThreadReadInput {
    channelId: ID
    groupChatId: ID
    directChatId: ID
  }

  type User {
    id: ID!
    email: String!
    firstName: String
    lastName: String
    middleName: String
    birthDate: DateTime
    avatarUrl: String
    phone: String
    status: PresenceStatus
    statusEmoji: String
    statusText: String
    title: String
    department: String
    role: OrgRole
    lastSeen: DateTime
    """Состояние папок чатов (JSON), только у самого пользователя в me / при обновлении профиля."""
    chatFoldersJson: String
  }

  type Organization {
    id: ID!
    name: String!
    domain: String
    logoUrl: String
    settings: JSON
  }

  type Workspace {
    id: ID!
    name: String!
    description: String
    avatarUrl: String
    role: WorkspaceRole!
    createdAt: DateTime!
  }

  type WorkspaceMember {
    role: WorkspaceRole!
    user: User!
  }

  type Channel {
    id: ID!
    workspaceId: ID!
    name: String!
    type: ChannelType!
    description: String
    avatarUrl: String
    createdByUserId: ID!
    isSystem: Boolean!
    isArchived: Boolean!
    createdAt: DateTime!
  }

  type Message {
    id: ID!
    channelId: ID
    groupChatId: ID
    directChatId: ID
    author: User!
    content: String!
    type: MessageType!
    parentMessageId: ID
    isDeleted: Boolean!
    editedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
    reactions: [Reaction!]!
    file: File
  }

  type DirectChat {
    id: ID!
    userIds: [ID!]!
  }

  type DirectChatMessage {
    id: ID!
    directChatId: ID!
    author: User!
    content: String!
    type: MessageType!
    parentMessageId: ID
    reactions: [Reaction!]!
    file: File
    createdAt: DateTime!
    updatedAt: DateTime!
    editedAt: DateTime
  }

  type GroupChat {
    id: ID!
    name: String!
    memberIds: [ID!]!
    createdByUserId: ID!
    avatarUrl: String
  }

  input SendDirectMessageInput {
    userId: ID!
    content: String!
    parentMessageId: ID
  }

  input SendDirectFileMessageInput {
    directChatId: ID!
    fileId: ID!
    kind: MessageType! # file|voice
  }

  input CreateGroupChatInput {
    name: String!
    memberIds: [ID!]!
  }

  input SendGroupChatMessageInput {
    groupChatId: ID!
    content: String!
    parentMessageId: ID
  }

  input SendGroupChatFileMessageInput {
    groupChatId: ID!
    fileId: ID!
    kind: MessageType! # file|voice
  }

  type Notification {
    id: ID!
    type: String!
    isRead: Boolean!
    createdAt: DateTime!
    payload: JSON
  }

  type NotificationPreference {
    id: ID!
    mode: NotificationPreferenceMode!
    channelId: ID
    groupChatId: ID
    directChatId: ID
    updatedAt: DateTime!
  }

  input SetNotificationPreferenceInput {
    channelId: ID
    groupChatId: ID
    directChatId: ID
    mode: NotificationPreferenceMode!
  }

  type GlobalSearchResult {
    users: [User!]!
    channels: [Channel!]!
    messages: [Message!]!
    files: [FileStub!]!
  }

  type FileStub {
    id: ID!
    url: String!
  }

  type File {
    id: ID!
    mimeType: String!
    size: Int!
    originalName: String
    downloadUrl: String
    avStatus: String!
    avCheckedAt: DateTime
    blockedReason: String
  }

  type PresignedUpload {
    fileId: ID!
    key: String!
    uploadUrl: String!
  }

  input CreatePresignedUploadInput {
    mimeType: String!
    size: Int!
    originalName: String
  }

  input MarkFileScannedInput {
    fileId: ID!
    status: String!
    blockedReason: String
  }

  type Reaction {
    emoji: String!
    count: Int!
    viewerHasReacted: Boolean!
  }

  type MessageConnection {
    items: [Message!]!
    nextCursor: ID
  }

  scalar JSON

  type RegisterOrganizationPayload {
    viewer: Viewer!
    organizationId: ID!
  }

  type LoginPayload {
    accessToken: String
    viewer: Viewer
    needsEmailOtp: Boolean
    challengeId: String
    emailMasked: String
  }

  type TwoFaSetupPayload {
    otpAuthUrl: String!
    qrDataUri: String!
  }

  type TwoFaVerifyPayload {
    ok: Boolean!
    backupCodes: [String!]!
  }

  input UpdateUserInput {
    userId: ID!
    firstName: String
    lastName: String
    middleName: String
    birthDate: DateTime
    avatarUrl: String
    phone: String
    status: PresenceStatus
    statusEmoji: String
    statusText: String
    title: String
    department: String
    chatFoldersJson: String
  }

  input UpdateGroupChatInput {
    groupChatId: ID!
    name: String
    avatarUrl: String
  }

  input GroupChatAddMembersInput {
    groupChatId: ID!
    userIds: [ID!]!
  }

  input UpdateChannelInput {
    channelId: ID!
    name: String
    avatarUrl: String
  }

  type Invite {
    id: ID!
    email: String!
    role: OrgRole!
    department: String
    createdAt: DateTime
    expiresAt: DateTime
    acceptedAt: DateTime
    revokedAt: DateTime
    inviteToken: String
  }

  input InviteUserInput {
    organizationId: ID!
    email: String!
    role: OrgRole
    department: String
  }

  input CreateOrganizationUserInput {
    organizationId: ID!
    email: String!
    fullName: String
    password: String!
    role: OrgRole
    department: String
  }

  input AcceptInviteInput {
    organizationId: ID!
    token: String!
    password: String!
    firstName: String
    lastName: String
  }

  type EmailVerificationRequestPayload {
    ok: Boolean!
    token: String
  }

  input VerifyEmailInput {
    organizationId: ID!
    token: String!
  }

  input SetUserPasswordInput {
    organizationId: ID!
    userId: ID!
    password: String!
  }

  input DeactivateUserInput {
    organizationId: ID!
    userId: ID!
  }

  input RevokeInviteInput {
    organizationId: ID!
    inviteId: ID!
  }

  input SetUserRoleInput {
    organizationId: ID!
    userId: ID!
    role: OrgRole!
  }

  input UpdateOrganizationSettingsInput {
    organizationId: ID!
    name: String
    logoUrl: String
    settings: OrganizationSettingsInput
  }

  input OrganizationSettingsInput {
    retentionDays: Int
    fileSizeLimit: Int
    maxFileSizeMb: Int
    blockedExtensions: [String!]
    allowedMimeTypes: [String!]
    allowedAuthMethods: [String!]
  }

  input CreateWorkspaceInput {
    name: String!
    description: String
    avatarUrl: String
  }

  input UpdateWorkspaceInput {
    workspaceId: ID!
    name: String
    description: String
    avatarUrl: String
  }

  input ArchiveWorkspaceInput {
    workspaceId: ID!
    isArchived: Boolean!
  }

  input DeleteWorkspaceInput {
    workspaceId: ID!
  }

  input WorkspaceAddMemberInput {
    workspaceId: ID!
    userId: ID!
    role: WorkspaceRole!
  }

  input WorkspaceRemoveMemberInput {
    workspaceId: ID!
    userId: ID!
  }

  input CreateChannelInput {
    workspaceId: ID!
    name: String!
    type: ChannelType!
    description: String
  }

  input ChannelAddMemberInput {
    channelId: ID!
    userId: ID!
  }

  input ChannelRemoveMemberInput {
    channelId: ID!
    userId: ID!
  }

  input ArchiveChannelInput {
    channelId: ID!
  }

  input DeleteChannelInput {
    channelId: ID!
  }

  input SendMessageInput {
    channelId: ID!
    content: String!
    parentMessageId: ID
  }

  input SendFileMessageInput {
    channelId: ID!
    fileId: ID!
    kind: MessageType! # file|voice
  }

  input EditMessageInput {
    messageId: ID!
    content: String!
  }

  input DeleteMessageInput {
    messageId: ID!
  }

  input ToggleReactionInput {
    messageId: ID!
    emoji: String!
  }

  input ForwardMessagesInput {
    messageIds: [ID!]!
    channelId: ID
    groupChatId: ID
    directChatId: ID
    hideAuthor: Boolean = false
  }

  input PinMessageInput {
    messageId: ID!
  }

  input UnpinMessageInput {
    messageId: ID!
  }
`;
