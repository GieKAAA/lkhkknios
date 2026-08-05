import { FontAwesome5, Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BlurView } from "expo-blur";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import LKHScreen from "../../components/LKHScreen";
import LoginScreen from "../../components/LoginScreen";
import ProfileScreen from "../../components/ProfileScreen";

export default function Index() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [currentTab, setCurrentTab] = useState<"lkh" | "profile">("lkh");

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const token = await AsyncStorage.getItem("@user_token");
        if (token) {
          setIsLoggedIn(true);
        }
      } catch (error) {
        console.error("Gagal mengecek status login", error);
      } finally {
        setIsCheckingAuth(false);
      }
    };

    checkAuthStatus();
  }, []);

  if (isCheckingAuth) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#059669" />
      </View>
    );
  }

  if (!isLoggedIn) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />
        <LoginScreen onLoginSuccess={() => setIsLoggedIn(true)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      {/* Konten Berdasarkan Tab Aktif */}
      <View style={styles.content}>
        {currentTab === "lkh" ? (
          <LKHScreen />
        ) : (
          <ProfileScreen onLogout={() => setIsLoggedIn(false)} />
        )}
      </View>

      {/* Tab bar mengambang ala iOS 26 / Instagram terbaru: kaca buram asli
          (BlurView, bukan warna solid) supaya benar-benar tembus pandang,
          dan setiap item mengisi separuh lebar bar + tinggi penuh supaya
          area sentuhnya besar (tidak mudah salah tindis). */}
      <View style={styles.tabBarWrap}>
        <BlurView intensity={95} tint="light" style={styles.tabBar}>
          <TouchableOpacity
            style={styles.tabItem}
            onPress={() => setCurrentTab("lkh")}
            activeOpacity={0.75}
          >
            <View style={[styles.tabPill, currentTab === "lkh" && styles.tabPillActive]}>
              <FontAwesome5
                name="calendar-alt"
                size={17}
                color={currentTab === "lkh" ? "#059669" : "#3A4453"}
              />
              <Text
                style={[
                  styles.tabText,
                  currentTab === "lkh" && styles.tabTextActive,
                ]}
              >
                LKH
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.tabItem}
            onPress={() => setCurrentTab("profile")}
            activeOpacity={0.75}
          >
            <View
              style={[styles.tabPill, currentTab === "profile" && styles.tabPillActive]}
            >
              <Ionicons
                name="person"
                size={18}
                color={currentTab === "profile" ? "#059669" : "#3A4453"}
              />
              <Text
                style={[
                  styles.tabText,
                  currentTab === "profile" && styles.tabTextActive,
                ]}
              >
                Profil
              </Text>
            </View>
          </TouchableOpacity>
        </BlurView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F1F5F9",
  },
  content: {
    flex: 1,
    // Menyisakan ruang di bawah supaya konten (termasuk tombol yang
    // posisinya absolute di dalam LKHScreen/ProfileScreen) tidak ketimpa
    // tab bar melayang (wrapper bottom:10 + tinggi tabBar 64 + jarak aman).
    paddingBottom: 0,
  },

  // Bungkus luar: cuma untuk shadow + posisi melayang.
  tabBarWrap: {
    position: "absolute",
    left: 28,
    right: 28,
    bottom: 14,
    height: 62,
    borderRadius: 31,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 18,
    elevation: 8,
  },
  // Bar kaca asli (BlurView) - overlay warnanya sengaja sangat tipis supaya
  // efek buramnya yang terlihat, bukan warna solid ("kotak").
  tabBar: {
    flex: 1,
    flexDirection: "row",
    borderRadius: 31,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  // Area sentuh: separuh lebar bar x tinggi penuh - jauh lebih besar dari
  // ukuran ikon/teksnya sendiri, supaya tidak mudah salah tindis.
  tabItem: {
    flex: 1,
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  // Pil di dalam area sentuh, sedikit lebih kecil dari sel-nya (ala iOS 26 /
  // Instagram terbaru) - ini yang tampak, tapi bukan penentu area sentuh.
  tabPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    width: "88%",
    borderRadius: 22,
  },
  // Aksen "liquid glass" hijau: bukan hijau solid, tapi kaca tipis
  // berwarna hijau dengan tepi menyala lembut, seperti tetesan cairan.
  tabPillActive: {
    backgroundColor: "rgba(16,185,129,0.22)",
    borderWidth: 1,
    borderColor: "rgba(16,185,129,0.55)",
    shadowColor: "#10B981",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 4,
  },
  tabText: {
    fontSize: 13,
    color: "#3A4453",
    fontWeight: "700",
    marginLeft: 7,
  },
  tabTextActive: {
    color: "#059669",
  },
});
