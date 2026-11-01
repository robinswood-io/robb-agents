import common from "./common.json";
import conversation from "./conversation.json";
import editor from "./editor.json";
import missions from "./missions.json";
import onboarding from "./onboarding.json";
import settingsInterface from "./settings-interface.json";
import settingsServices from "./settings-services.json";
import webui from "./webui.json";
import workspace from "./workspace.json";

export default {
  ...common,
  ...conversation,
  ...editor,
  ...missions,
  ...onboarding,
  ...settingsInterface,
  ...settingsServices,
  ...webui,
  ...workspace,
};
