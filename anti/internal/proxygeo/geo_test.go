package proxygeo

import "testing"

func TestCountryFromUser(t *testing.T) {
	cases := map[string]string{
		"example-corp.mobile.res-country-IN-state-1264418-city-1259229-hold-session-session-abc123": "IN",
		"user-country-US-session-abc": "US",
		"login;country-DE":            "DE",
		"cc-BR-foo":                   "BR",
		"plainuser":                   "",
	}
	for in, want := range cases {
		got := countryFromText(in)
		if got != want {
			t.Fatalf("%q => %q want %q", in, got, want)
		}
	}
}

func TestIndiaTZ(t *testing.T) {
	if timezoneForCountry("IN") != "Asia/Kolkata" {
		t.Fatal(timezoneForCountry("IN"))
	}
	if langForCountry("IN") != "en-IN" {
		t.Fatal(langForCountry("IN"))
	}
}

func TestLookupUsesUsernameWhenNoNetwork(t *testing.T) {
	// invalid host forces exit fail; username still has country-IN
	raw := "socks5://user-res-country-IN-session-x:pass@127.0.0.1:1"
	info := Lookup(raw)
	if info.Timezone != "Asia/Kolkata" {
		t.Fatalf("tz=%q via=%q err=%q", info.Timezone, info.Via, info.Error)
	}
	if info.Via != "username" {
		t.Fatalf("via=%q want username", info.Via)
	}
	if info.CountryCode != "IN" {
		t.Fatalf("cc=%q", info.CountryCode)
	}
}
