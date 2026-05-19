import * as audio from './audio.js';
import { settings } from './settings.js';

export function createTask(store, title, districtId) {
  if (!title || !title.trim()) return null;
  const task = store.addTask(title.trim(), districtId);
  audio.play('add');
  settings.haptic(8);
  return task;
}

export function startTask(store, skylineApi, taskId) {
  const task = store.getTask(taskId);
  if (!task || task.status !== 'pending') return null;

  const district = store.getDistrict(task.districtId);
  if (!district) return null;

  const placement = skylineApi.nextCell(district.id);
  if (!placement) return null;

  if (placement.overflowed) {
    skylineApi.toast && skylineApi.toast('District is full. Add a new district.', { variant: 'warn' });
  }

  const buildingData = skylineApi.generateBuildingForTask(task);
  buildingData.cell = {
    wx: placement.world.wx,
    wy: placement.world.wy,
    col: placement.world.col,
    row: placement.world.row
  };

  const started = store.startTask(taskId, buildingData);
  if (skylineApi.animateConstructionStart) {
    skylineApi.animateConstructionStart(buildingData, district.color);
  }
  audio.play('add');
  settings.haptic(10);
  return started;
}

export function completeTask(store, skylineApi, taskId) {
  const task = store.getTask(taskId);
  if (!task || task.status === 'complete') return null;

  const district = store.getDistrict(task.districtId);
  if (!district) return null;

  // If already in_progress the cell + building are locked from the start.
  let buildingData = task.building;
  if (!buildingData || !buildingData.cell) {
    const placement = skylineApi.nextCell(district.id);
    if (!placement) return null;
    if (placement.overflowed) {
      skylineApi.toast && skylineApi.toast('District is full. Add a new district.', { variant: 'warn' });
    }
    buildingData = skylineApi.generateBuildingForTask(task);
    buildingData.cell = {
      wx: placement.world.wx,
      wy: placement.world.wy,
      col: placement.world.col,
      row: placement.world.row
    };
  }

  const completed = store.completeTask(taskId, buildingData);
  skylineApi.animateRise(buildingData, district.color);
  audio.play('complete');
  settings.haptic(15);
  return completed;
}

export function cycleTask(store, skylineApi, taskId) {
  const t = store.getTask(taskId);
  if (!t) return null;
  if (t.status === 'pending')     return startTask(store, skylineApi, taskId);
  if (t.status === 'in_progress') return completeTask(store, skylineApi, taskId);
  return null;
}

export function deleteTask(store, taskId) {
  const task = store.getTask(taskId);
  if (!task) return null;
  const snapshot = store.deleteTask(taskId);
  audio.play('delete');
  settings.haptic(8);
  return snapshot;
}

export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
