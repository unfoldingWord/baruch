import { APP_VERSION } from '../generated/version.js';
import { PromptSlot, PROMPT_OVERRIDE_SLOTS } from '../types/prompt-overrides.js';

const TEMPLATE_VARIABLES: Record<string, string> = {
  version: APP_VERSION,
};

export function replaceTemplateVariables(
  text: string,
  variables: Record<string, string> = TEMPLATE_VARIABLES
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    // eslint-disable-next-line security/detect-object-injection -- name is from \w+ regex (word chars only); Object.hasOwn guards prototype access
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return value !== undefined ? value : match;
  });
}

export function applyTemplateVariables(
  resolved: Required<Record<PromptSlot, string>>
): Required<Record<PromptSlot, string>> {
  const result = { ...resolved };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- slot is from PROMPT_OVERRIDE_SLOTS constant
    result[slot] = replaceTemplateVariables(result[slot]);
  }
  return result;
}
