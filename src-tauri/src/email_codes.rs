//! Local-only verification-code detection. Email contents never go to an AI service.
use regex::Regex;
use std::sync::LazyLock;

static CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
    r"(?i)\b(?:verification code|security code|confirmation code|authentication code|(?:one[ -]time|single[ -]use) (?:password|code|passcode)|sign[ -]?in code|log[ -]?in code|access code|steam guard code|apple (?:id|account) code|otp|passcode|your code)\b"
).unwrap()
});
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:[0-9]{3}[- ][0-9]{3}|[A-Za-z0-9]{4,10})\b").unwrap());
static HIDDEN_HTML: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<!--.*?-->|<(?:script|style|head)\b[^>]*>.*?</(?:script|style|head)\s*>")
        .unwrap()
});
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#(x[0-9a-fA-F]+|[0-9]+);").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)https?://\S+").unwrap());

/// Extract text without executing HTML, loading images, or considering CSS/URL numbers.
pub fn html_text(html: &str) -> String {
    let visible = HIDDEN_HTML.replace_all(html, " ");
    let text = TAG.replace_all(&visible, " ");
    let decoded = ENTITY.replace_all(&text, |captures: &regex::Captures<'_>| {
        let value = &captures[1];
        let number = value
            .strip_prefix('x')
            .map_or_else(|| value.parse::<u32>(), |hex| u32::from_str_radix(hex, 16));
        number
            .ok()
            .and_then(char::from_u32)
            .unwrap_or(' ')
            .to_string()
    });
    decoded
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn candidate(value: &str) -> Option<String> {
    let code: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let numeric = code.bytes().all(|c| c.is_ascii_digit());
    if (numeric && (4..=8).contains(&code.len()))
        || (!numeric
            && (5..=10).contains(&code.len())
            && code.bytes().any(|c| c.is_ascii_digit())
            && code.bytes().any(|c| c.is_ascii_uppercase())
            && !code.bytes().any(|c| c.is_ascii_lowercase()))
    {
        Some(code)
    } else {
        None
    }
}

fn in_context(text: &str) -> Option<String> {
    let text = URL.replace_all(text, " ");
    let text = text.as_ref();
    for context in CONTEXT.find_iter(text) {
        // Prefer the token following the label; look behind for "123456 is your code".
        let after = &text[context.end()..];
        for token in TOKEN.find_iter(after).take_while(|m| m.start() <= 64) {
            if let Some(code) = candidate(token.as_str()) {
                return Some(code);
            }
        }
        let before = &text[..context.start()];
        for token in TOKEN
            .find_iter(before)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .take_while(|m| before.len() - m.end() <= 40)
        {
            if let Some(code) = candidate(token.as_str()) {
                return Some(code);
            }
        }
    }
    None
}

pub fn extract(subject: &str, snippet: &str, body: Option<&str>) -> Option<String> {
    in_context(subject)
        .or_else(|| body.and_then(in_context))
        .or_else(|| in_context(snippet))
        .or_else(|| {
            // Some services put the label only in the subject and the code alone in the body.
            if !CONTEXT.is_match(subject) {
                return None;
            }
            let text = URL.replace_all(body.unwrap_or(snippet), " ");
            TOKEN
                .find_iter(&text)
                .take_while(|m| m.start() <= 256)
                .find_map(|m| candidate(m.as_str()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_numeric_grouped_and_alphanumeric_codes() {
        for (text, code) in [
            (
                "Your verification code is 012345. Expires in 10 minutes.",
                "012345",
            ),
            ("123456 is your verification code", "123456"),
            ("Your one-time password: 123-456", "123456"),
            ("Sign-in code: AB12CD34", "AB12CD34"),
            ("Your OTP is 9382", "9382"),
            ("Your Steam Guard code is 2R9KQ", "2R9KQ"),
            ("Your single-use code: 032675", "032675"),
        ] {
            assert_eq!(extract(text, "", None).as_deref(), Some(code), "{text}");
        }
        assert_eq!(
            extract(
                "Your verification code",
                "",
                Some("Welcome!\n007831\nValid for 5 minutes.")
            )
            .as_deref(),
            Some("007831")
        );
    }

    #[test]
    fn ignores_promotions_receipts_urls_and_unrelated_numbers() {
        for text in [
            "Order 123456 has shipped",
            "Discount code SAVE2026",
            "Your OTP expires in 10 minutes",
            "Your verification code: 123456789012",
            "Track https://example.com/123456",
            "Your code is at https://example.com/123456",
            "Verification code instructions are available on our website.",
        ] {
            assert_eq!(extract(text, "", None), None, "{text}");
        }
    }

    #[test]
    fn reads_html_text_without_using_style_script_or_link_numbers() {
        let text = html_text(
            "<html><head><style>.otp{color:#123456}</style></head><body><p>Your verification code</p><a href='https://example.com/999999'><b>&#48;&#x31;2345</b></a><script>123456</script></body></html>",
        );
        assert_eq!(
            extract("Sign in", "", Some(&text)).as_deref(),
            Some("012345")
        );
    }
}
