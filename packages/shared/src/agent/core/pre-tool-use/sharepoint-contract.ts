import { isUnknownArray } from '../../../utils/json.ts';
import { latestSignedResumeAuthoritySegment } from './signed-resume-targets.ts';

function isBoundedJsonData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean'
    || typeof value === 'string' && value.length <= 8_192
    || typeof value === 'number' && Number.isFinite(value)) return true;
  if (depth >= 6 || !value || typeof value !== 'object') return false;
  if (isUnknownArray(value)) return value.length <= 128
    && value.every((item: unknown) => isBoundedJsonData(item, depth + 1));
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 32 && entries.every(([key, item]) => (
      key.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(key)
        && isBoundedJsonData(item, depth + 1)
    ));
  } catch {
    return false;
  }
}

function isBoundedSharePointColumnFacet(type: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || isUnknownArray(value)) return false;
  const facet = value as Record<string, unknown>;
  const keysAre = (allowed: readonly string[]) => (
    Object.keys(facet).every(key => allowed.includes(key))
  );
  const optionalBoolean = (key: string) => (
    facet[key] === undefined || typeof facet[key] === 'boolean'
  );
  const optionalBoundedInteger = (key: string, minimum: number, maximum: number) => (
    facet[key] === undefined
      || typeof facet[key] === 'number'
        && Number.isInteger(facet[key])
        && facet[key] >= minimum
        && facet[key] <= maximum
  );

  if (type === 'boolean') return Object.keys(facet).length === 0;
  if (type === 'choice') {
    return keysAre(['allowTextEntry', 'choices', 'displayAs'])
      && optionalBoolean('allowTextEntry')
      && (facet["choices"] === undefined || isUnknownArray(facet["choices"])
        && facet["choices"].length > 0 && facet["choices"].length <= 128
        && facet["choices"].every((choice: unknown) => typeof choice === 'string'
          && choice.length > 0 && choice.length <= 255 && !/\0/u.test(choice)))
      && (facet["displayAs"] === undefined
        || typeof facet["displayAs"] === 'string'
          && ['checkBoxes', 'dropDownMenu', 'radioButtons'].includes(facet["displayAs"]));
  }
  if (type === 'personOrGroup') {
    return keysAre(['allowMultipleSelection', 'chooseFromType', 'displayAs'])
      && optionalBoolean('allowMultipleSelection')
      && (facet["chooseFromType"] === undefined
        || typeof facet["chooseFromType"] === 'string'
          && ['peopleAndGroups', 'peopleOnly'].includes(facet["chooseFromType"]))
      && (facet["displayAs"] === undefined
        || typeof facet["displayAs"] === 'string' && [
          'account', 'department', 'id', 'name', 'nameWithPicture',
          'nameWithPictureAndDetails', 'nameWithPresence', 'sipAddress',
          'title', 'userName', 'workPhone',
        ].includes(facet["displayAs"]));
  }
  if (type === 'text') {
    return keysAre([
      'allowMultipleLines', 'appendChangesToExistingText', 'linesForEditing',
      'maxLength', 'textType',
    ])
      && optionalBoolean('allowMultipleLines')
      && optionalBoolean('appendChangesToExistingText')
      && optionalBoundedInteger('linesForEditing', 1, 1_000)
      && optionalBoundedInteger('maxLength', 1, 1_000_000)
      && (facet["textType"] === undefined
        || typeof facet["textType"] === 'string'
          && ['plain', 'richText'].includes(facet["textType"]));
  }
  if (type === 'dateTime') {
    return keysAre(['displayAs', 'format'])
      && (facet["displayAs"] === undefined
        || typeof facet["displayAs"] === 'string'
          && ['default', 'friendly', 'standard'].includes(facet["displayAs"]))
      && (facet["format"] === undefined
        || typeof facet["format"] === 'string'
          && ['dateOnly', 'dateTime'].includes(facet["format"]));
  }
  if (type === 'number') {
    const minimum = facet["minimum"];
    const maximum = facet["maximum"];
    return keysAre(['decimalPlaces', 'displayAs', 'maximum', 'minimum'])
      && (facet["decimalPlaces"] === undefined
        || typeof facet["decimalPlaces"] === 'string' && [
          'automatic', 'none', 'one', 'two', 'three', 'four', 'five',
        ].includes(facet["decimalPlaces"]))
      && (facet["displayAs"] === undefined
        || typeof facet["displayAs"] === 'string'
          && ['number', 'percentage'].includes(facet["displayAs"]))
      && (minimum === undefined || typeof minimum === 'number' && Number.isFinite(minimum))
      && (maximum === undefined || typeof maximum === 'number' && Number.isFinite(maximum))
      && !(typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum);
  }
  return false;
}

interface BoundedResumedSharePointCreationContract {
  segment: string;
  site: string;
  listName: string;
  driveId?: string;
  folderName?: string;
}

export function boundedResumedSharePointCreationContract(
  objectiveSegments: readonly string[],
): BoundedResumedSharePointCreationContract | undefined {
  const segment = latestSignedResumeAuthoritySegment(objectiveSegments);
  if (!segment || !/Microsoft Graph\s*\/\s*API/u.test(segment)
    || !/Cr[ée]e par API/u.test(segment)
    || /\b(?:(?:ne|n['’])\s+cr[ée]\w*[^.!?;\n]{0,48}\b(?:pas|jamais|plus)|(?:do\s+not|don't|never)\s+create|sans\s+cr[ée]ation)\b/iu.test(segment)) return undefined;
  const site = /cible exacte[^`\r\n]{0,120}`([a-z0-9.-]+,[a-f0-9-]{36},[a-f0-9-]{36})`/iu.exec(segment)?.[1];
  const listName = /(?:liste|list)[^`\r\n]{0,220}(?:d[ée]di[ée]e?|dedicated)[^`\r\n]{0,80}`([^`\r\n]{1,255})`/iu.exec(segment)?.[1];
  if (!site || !listName) return undefined;
  const driveId = /^Drive documentaire exact\s*:\s*`([A-Za-z0-9_!-]{10,255})`\s*$/imu.exec(segment)?.[1];
  const folderName = /^Dossier documentaire exact\s*:\s*`([^`\r\n]{1,255})`\s*$/imu.exec(segment)?.[1];
  return {
    segment,
    site,
    listName,
    ...(driveId !== undefined ? { driveId } : {}),
    ...(folderName !== undefined ? { folderName } : {}),
  };
}

export function isBoundedResumedSharePointCreation(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): boolean {
  if (toolName !== 'mcp__plc-microsoft-365__graph_request'
    || input["method"] !== 'POST'
    || Object.keys(input).some(key => ![
      'method', 'endpoint', 'body', '_displayName', '_intent',
    ].includes(key))) return false;
  const contract = boundedResumedSharePointCreationContract(objectiveSegments);
  if (!contract) return false;
  const { driveId, folderName, listName, site } = contract;
  const body = input["body"];
  if (!body || typeof body !== 'object' || isUnknownArray(body)
    || !isBoundedJsonData(body)) return false;
  const record = body as Record<string, unknown>;
  if (typeof input["endpoint"] === 'string' && input["endpoint"].startsWith('drives/')) {
    const folder = record["folder"];
    return !!driveId && !!folderName
      && folderName === folderName.trim()
      && folderName !== '.' && folderName !== '..'
      && !/[\/\\\0]/u.test(folderName)
      && input["endpoint"] === `drives/${driveId}/root/children`
      && Object.keys(record).length === 3
      && record["name"] === folderName
      && record['@microsoft.graph.conflictBehavior'] === 'fail'
      && !!folder && typeof folder === 'object' && !isUnknownArray(folder)
      && Object.keys(folder).length === 0;
  }
  if (input["endpoint"] !== `sites/${site}/lists`) return false;
  if (Object.keys(record).some(key => !['displayName', 'description', 'columns', 'list'].includes(key))
    || record["displayName"] !== listName
    || typeof record["description"] !== 'string' || record["description"].length > 8_192) return false;
  const list = record["list"];
  if (!list || typeof list !== 'object' || isUnknownArray(list)
    || Object.keys(list).length !== 1
    || (list as Record<string, unknown>)["template"] !== 'genericList') return false;
  // The list creation must be atomic. Allowing the empty-list retry would
  // strand the mission on later opaque `/lists/{id}/columns` mutations whose
  // discovered ID is not present in the authenticated human objective.
  if (!isUnknownArray(record["columns"]) || record["columns"].length === 0
    || record["columns"].length > 100) return false;
  const typeKeys = new Set([
    'boolean', 'choice', 'personOrGroup', 'text', 'dateTime', 'number',
  ]);
  return record["columns"].every((column: unknown) => {
    if (!column || typeof column !== 'object' || isUnknownArray(column)) return false;
    const item = column as Record<string, unknown>;
    if (Object.keys(item).some(key => ![
      'name', 'displayName', 'description', 'required', ...typeKeys,
    ].includes(key))) return false;
    if (typeof item["name"] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item["name"])
      || typeof item["displayName"] !== 'string' || item["displayName"].length > 255
      || item["description"] !== undefined && (typeof item["description"] !== 'string'
        || item["description"].length > 4_096)
      || item["required"] !== undefined && typeof item["required"] !== 'boolean') return false;
    const selectedTypes = Object.keys(item).filter(key => typeKeys.has(key));
    return selectedTypes.length === 1
      && isBoundedSharePointColumnFacet(selectedTypes[0]!, item[selectedTypes[0]!]);
  });
}
