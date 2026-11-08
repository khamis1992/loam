import type { McpServerConfig } from "../config.js";
import { upsertMcpServer } from "./mcpConfig.js";
import { SERVICE_CAPABILITY_GROUPS } from "./servicePackCapabilities.js";

export interface ServicePackDefinition {
  id: string;
  title: string;
  category: string;
  description: string;
  capabilities: string[];
  platforms: NodeJS.Platform[];
}

const allPlatforms: NodeJS.Platform[] = ["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin"];
const appleOnly: NodeJS.Platform[] = ["darwin"];

const pack = (
  id: string,
  title: string,
  category: string,
  capabilities: string[],
  description: string,
  platforms: NodeJS.Platform[] = allPlatforms,
): ServicePackDefinition => ({ id, title, category, description, capabilities, platforms });

export const SERVICE_PACKS: ServicePackDefinition[] = [
  pack("slack", "Slack", "communications", ["SetUpSlack", "OfferSlackConnect", "SetSlackStatus", "EditOwnSlackMessage", "DeleteOwnSlackMessage", "ReactToSlackMessage", "CreateChannel", "UpdateChannel", "DisconnectChannel", "SetProactiveMessaging", "DraftExternalMessage", "ReactToMessage", "SendFeedback", "SendMessage", "SendToAgent", "SendToUser"], "Connect a Slack MCP server for channels, status, reactions and proactive messages."),
  pack("microsoft-teams", "Microsoft Teams", "communications", ["SetUpMicrosoftTeams", "SetMicrosoftTeamsStatus", "DeleteOwnMicrosoftTeamsMessage", "ReactToMicrosoftTeamsMessage", "CreateChannel", "UpdateChannel", "DisconnectChannel", "SetProactiveMessaging"], "Connect Microsoft Teams messaging and notification workflows."),
  pack("email", "Email", "communications", ["CheckEmailInboxAvailability", "ClaimEmailInbox", "ListEmailInboxes", "OfferEmailAddress", "ReadEmailAttachment", "ReadEmailThread", "SearchEmailThreads", "SendEmail", "MacDraftMail", "MacReadMail"], "Add full inbox, attachment, search and send operations through an email MCP provider."),
  pack("imessage", "iMessage", "communications", ["CheckIMessagePermissions", "FetchIMessageAttachment", "FindIMessageChats", "IMessageActivity", "SearchIMessages", "SendIMessage"], "Use an Apple Messages MCP bridge with explicit grants.", appleOnly),
  pack("mac-notes", "Mac Notes", "documentsCanvas", ["MacReadNotes", "MacWriteNotes"], "Read and write Apple Notes through a macOS bridge.", appleOnly),
  pack("meetings", "Meetings", "meetingsVoice", SERVICE_CAPABILITY_GROUPS.meetingsVoice!, "Find, join and leave meetings, read transcripts and summaries, and respond with approval."),
  pack("voice-calls", "Voice calls", "meetingsVoice", ["PresentCallQuestion"], "Place and manage voice-call questions through a telephony MCP provider."),
  pack("ios-home", "iOS Home", "mobileDevices", ["IOSControlHome", "IOSReadHome"], "Read and control HomeKit accessories through an iOS MCP bridge.", appleOnly),
  pack("ios-health", "iOS Health", "mobileDevices", ["IOSReadHealth"], "Read user-authorized Health data through an iOS MCP bridge.", appleOnly),
  pack("ios-reminders", "iOS Reminders", "mobileDevices", ["IOSManageAlarms", "IOSReadReminders", "IOSWriteReminders"], "Read and write iOS reminders and alarms.", appleOnly),
  pack("mobile-calendar", "Mobile calendar and contacts", "mobileDevices", ["MobileReadCalendar", "MobileWriteCalendar", "MobileReadContacts", "FindContacts", "DraftCalendarInvite"], "Use mobile calendar, invitations and contact operations."),
  pack("device-location", "Device location and calls", "mobileDevices", ["DeviceGetLocation", "MobileSetAlarm", "place_phone_call"], "Use consented device location, alarms and phone calls."),
  pack("onepassword", "1Password and secure values", "credentialsSecurity", ["BrowserSecureFill", "FillCredential", "GetCredentialProviderStatus", "ListAvailableSecureValues", "ListCredentials", "RequestOnePasswordConnect", "RequestOnePasswordLogins", "SetOnePasswordPreference", "Vault"], "Connect 1Password and secure-fill providers without exposing secret values to the model."),
  pack("automation", "Automation routines", "scmAutomation", ["UpdateRoutine"], "Create and update routines through an automation MCP provider."),
  pack("virtual-cards", "Virtual cards and user forms", "credentialsSecurity", ["RequestVirtualCard", "RequestUserForm", "RemapUserFormTargets"], "Request virtual cards and remap user forms through an approved payments MCP provider."),
  pack("flights", "Flights", "travelCommerce", ["FlightDetails", "FlightSearch"], "Search flights and retrieve itinerary details through a travel MCP provider."),
  pack("restaurants", "Restaurants and reservations", "travelCommerce", ["PlacesSearch", "ReserveTable", "RestaurantSearch"], "Search restaurants and places and request reservations."),
  pack("products", "Products", "travelCommerce", ["ProductSearch"], "Search product catalogs through a commerce MCP provider."),
  pack("weather", "Weather", "travelCommerce", ["WeatherForecast"], "Retrieve weather forecasts through a weather MCP provider."),
  pack("gitlab", "GitLab", "scmAutomation", ["RequestScmConnect", "FetchConnectedActivity", "ListReviewItems", "ResolveReviewItem"], "Connect GitLab repositories, activity and review items."),
  pack("bitbucket", "Bitbucket", "scmAutomation", ["RequestScmConnect", "FetchConnectedActivity", "ListReviewItems", "ResolveReviewItem"], "Connect Bitbucket repositories, activity and review items."),
  pack("azure-devops", "Azure DevOps", "scmAutomation", ["RequestScmConnect", "FetchConnectedActivity", "ListReviewItems", "ResolveReviewItem"], "Connect Azure DevOps repositories, activity and review items."),
];

export function servicePackById(id: string): ServicePackDefinition | undefined {
  return SERVICE_PACKS.find((pack) => pack.id === id);
}

export function installServicePack(id: string, name: string, input: unknown): McpServerConfig {
  const pack = servicePackById(id);
  if (!pack) throw new Error("service pack not found");
  if (!pack.platforms.includes(process.platform)) throw new Error(`${pack.title} is available only on ${pack.platforms.join(", ")}`);
  if (!name.trim()) throw new Error("server name is required");
  const config = upsertMcpServer(name.trim(), {
    ...(input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}),
    servicePackId: id,
    lazy: true,
  });
  return config;
}

export const BUILT_IN_CAPABILITY_GROUPS = [
  "mcpPlugins",
  "documentsCanvas",
  "tasksTranscriptsReview",
  "computerExecution",
  "memorySkills",
  "agentsTeamsTemplates",
  "webResearch",
  "subagents",
];
