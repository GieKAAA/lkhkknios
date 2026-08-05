import { Stack } from 'expo-router';
import React from 'react';

// index.tsx merender seluruh UI sendiri (termasuk tab bar LKH/Profil yang
// melayang) - jadi cukup satu screen tanpa header/tab bar bawaan di sini,
// tidak pakai `Tabs` supaya tidak ada tab bar ganda.
export default function TabLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
