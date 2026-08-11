package proxyfmt

import "testing"

func TestParseDataImpulseSimple(t *testing.T) {
	raw := "exampleuser__cr.in:examplepass@gw.example-proxy.com:823"
	p, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Host != "gw.example-proxy.com" || p.Port != 823 {
		t.Fatalf("host/port: %+v", p)
	}
	if p.User != "exampleuser__cr.in" || p.Pass != "examplepass" {
		t.Fatalf("user/pass: %+v", p)
	}
	if p.Scheme != "http" {
		t.Fatalf("scheme %s", p.Scheme)
	}
}

func TestParseDataImpulseTargeting(t *testing.T) {
	raw := "exampleuser__cr.in;state.andhrapradesh;city.anantapur;zip.515004,515701;asn.55836:examplepass@gw.example-proxy.com:10000"
	p, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Host != "gw.example-proxy.com" || p.Port != 10000 {
		t.Fatalf("%+v", p)
	}
	if p.User != "exampleuser__cr.in;state.andhrapradesh;city.anantapur;zip.515004,515701;asn.55836" {
		t.Fatalf("user=%q", p.User)
	}
	if p.Pass != "examplepass" {
		t.Fatalf("pass=%q", p.Pass)
	}
}

func TestParseMobileSession(t *testing.T) {
	raw := "example-corp.mobile.res-country-IN-state-1264418-city-1259229-hold-session-session-abc123:examplepass@1.2.3.4:443"
	p, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Host != "1.2.3.4" || p.Port != 443 {
		t.Fatalf("%+v", p)
	}
	if !p.HasAuth() {
		t.Fatal("want auth")
	}
}

func TestParseParts(t *testing.T) {
	p, err := ParseParts("1.2.3.4:443",
		"example-corp.mobile.res-country-IN-state-1264418-city-1259229-hold-session-session-abc123",
		"examplepass", "http")
	if err != nil {
		t.Fatal(err)
	}
	if p.Host != "1.2.3.4" || p.Port != 443 || p.Pass != "examplepass" {
		t.Fatalf("%+v", p)
	}
}

func TestParseHostPortUserPass(t *testing.T) {
	p, err := Parse("gw.example-proxy.com:823:user:pass")
	if err != nil {
		t.Fatal(err)
	}
	if p.Host != "gw.example-proxy.com" || p.Port != 823 || p.User != "user" || p.Pass != "pass" {
		t.Fatalf("%+v", p)
	}
}

func TestParseURL(t *testing.T) {
	p, err := Parse("socks5://u:p@1.2.3.4:1080")
	if err != nil {
		t.Fatal(err)
	}
	if p.Scheme != "socks5" || p.Host != "1.2.3.4" || p.Port != 1080 {
		t.Fatalf("%+v", p)
	}
}

func TestNormalizeInputCard(t *testing.T) {
	// English Login/Password labels (NormalizeInput)
	raw := "Host\n1.2.3.4:443\n\nLogin\nmyuser\n\nPassword\nmypass"
	n := NormalizeInput(raw)
	p, err := Parse(n)
	if err != nil {
		t.Fatal(err, n)
	}
	if p.Host != "1.2.3.4" || p.User != "myuser" || p.Pass != "mypass" {
		t.Fatalf("%+v from %q", p, n)
	}
}
