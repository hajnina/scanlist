#!/bin/bash
# The Gradle config signs with ../debug.jks (alias zen, password android). Generate a throwaway debug key:
cd "$(dirname "$0")/.." && keytool -genkeypair -keystore debug.jks -alias zen -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=BoNPUsai debug"
