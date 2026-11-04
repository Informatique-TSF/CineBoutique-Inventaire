import type { Location } from "../types/inventory";

import { API_BASE } from "@/lib/api/config";
import http from "@/lib/api/http";
import type { Shop } from "@/types/shop";
import type { ShopUser } from "@/types/user";

interface LocationPayload {
  label: string;
  code?: string;
  description?: string;
}

export const createLocation = async (
  payload: LocationPayload
): Promise<Location> => {
  const data = await http(`${API_BASE}/locations`, {
    method: "POST",
    body: payload,
  });
  return data as Location;
};

type LocationUpdatePayload = LocationPayload & { disabled?: boolean };

export const updateLocation = async (
  id: string,
  payload: Partial<LocationUpdatePayload>
): Promise<Location> => {
  const data = await http(`${API_BASE}/locations/${id}`, {
    method: "PUT",
    body: payload,
  });
  return data as Location;
};

export const disableLocation = async (id: string): Promise<Location> => {
  const data = await http(`${API_BASE}/locations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return data as Location;
};

const sanitizeIdentifier = (value: string): string => value.trim();

const buildShopUsersUrl = (shopId: string) => {
  const trimmed = sanitizeIdentifier(shopId);
  if (!trimmed) {
    throw new Error(
      "L'identifiant boutique est requis pour gérer les utilisateurs."
    );
  }
  return `${API_BASE}/shops/${encodeURIComponent(trimmed)}/users`;
};

type ShopUserPayload = {
  login: string;
  displayName: string;
  isAdmin: boolean;
};

type ShopUserUpdatePayload = ShopUserPayload & {
  id: string;
  disabled?: boolean;
};

export const createShopUser = async (
  shopId: string,
  payload: ShopUserPayload
): Promise<ShopUser> => {
  const data = await http(buildShopUsersUrl(shopId), {
    method: "POST",
    body: payload,
  });
  return data as ShopUser;
};

export const updateShopUser = async (
  shopId: string,
  payload: ShopUserUpdatePayload
): Promise<ShopUser> => {
  const data = await http(buildShopUsersUrl(shopId), {
    method: "PUT",
    body: payload,
  });
  return data as ShopUser;
};

export const disableShopUser = async (
  shopId: string,
  id: string
): Promise<ShopUser> => {
  const data = await http(buildShopUsersUrl(shopId), {
    method: "DELETE",
    body: { id },
  });
  return data as ShopUser;
};

type ShopUpdatePayload = {
  id: string;
  name: string;
  officeCode: string;
};

export const updateShop = async (payload: ShopUpdatePayload): Promise<Shop> => {
  const data = await http(`${API_BASE}/shops`, {
    method: "PUT",
    body: payload,
  });
  return data as Shop;
};
