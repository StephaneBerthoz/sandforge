#!/usr/bin/env bash
# A pair of hostile Developer Edition orgs reproducing what client orgs did to
# SandForge, on orgs we own and may break. test/fixtures/trap-org/README.md
# lists the traps.
#
#   test/scripts/trap-org.sh <connect|deploy|seed|verify|wipe> [source|target]
#
# Without a side, a command acts on both orgs, the source first. Only the two
# aliases below are ever touched, and either is refused unless the org behind
# it is a Developer Edition: a client org never is. Nothing printed names a
# user, a token or an auth URL: every sf call runs with --json and only chosen
# fields leave it, because the hints sf appends to an error spell out the
# username.

set -euo pipefail

readonly SOURCE_ORG='SANDFORGE-SOURCE'
readonly TARGET_ORG='SANDFORGE-TRAP'
# A Developer Edition holds 5 MB of data, about 2 500 records. 1 200 contacts
# still outnumber the 500 rows a DataOps backup reads outside a sandbox, which
# is what the Anonymize proof needs.
readonly CONTACTS=${TRAP_CONTACTS:-1200}
# The REST version SandForge speaks, so a probe meets what a run meets.
readonly API='v62.0'

FIXTURE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures/trap-org" && pwd)"
readonly FIXTURE
WORK="$(mktemp -d)"
readonly WORK

RESPONSE=''
CREATED=()
CLEANUP_ORG=''
UNEXPECTED=0

die() {
  printf 'trap-org: %s\n' "$*" >&2
  exit 1
}

say() { printf '%s\n' "$*"; }

usage() {
  sed -n '6p' "${BASH_SOURCE[0]}" | sed 's/^#  *//' >&2
  exit 2
}

# The records a verify run created go when it ends, however it ends.
cleanup() {
  if [[ -n $CLEANUP_ORG && ${#CREATED[@]} -gt 0 ]]; then remove_created "$CLEANUP_ORG"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- sf, without anything that names a user ----------------------------------

# sf with --json. Its stderr carries warnings that can name the org's user.
sfj() { sf "$@" --json 2>/dev/null; }

# The name and message of a failed sf call, without the hints sf appends.
sf_error() {
  jq -r '[.name, .message] | map(select(. != null and . != "")) | join(": ")' <<<"$1" 2>/dev/null ||
    printf 'no readable answer from sf'
}

# The username an alias stands for, read from the local alias file.
alias_user() {
  sfj alias list | jq -r --arg a "$1" '.result[]? | select(.alias == $a) | .value' | head -n 1
}

# Refuses every org but the two trap aliases, and either of them unless the org
# says it is a Developer Edition and no sandbox. A client org is a production
# or a sandbox of a paid edition, so it never passes, whatever alias it holds.
guard() {
  local org=$1 out kind
  [[ $org == "$SOURCE_ORG" || $org == "$TARGET_ORG" ]] ||
    die "refusing $org: this script only touches $SOURCE_ORG and $TARGET_ORG"
  [[ -n $(alias_user "$org") ]] || die "refusing $org: no such alias on this machine; run connect"
  out=$(sfj data query --target-org "$org" --query 'SELECT OrganizationType, IsSandbox FROM Organization') ||
    die "refusing $org: $(sf_error "$out")"
  kind=$(jq -r '.result.records[0] | "\(.OrganizationType)|\(.IsSandbox)"' <<<"$out")
  [[ $kind == 'Developer Edition|false' ]] ||
    die "refusing $org: not a Developer Edition (${kind%|*}, sandbox ${kind#*|})"
}

# Person accounts and multi-currency are features a Developer Edition lacks
# until someone turns them on in Setup. Each trap that needs one says so and is
# skipped instead of failing on a field the org does not have.
has_person_accounts() {
  call "$1" GET sobjects/Account/describe ''
  jq -e '.body.fields | map(.name) | index("IsPersonAccount")' <<<"$RESPONSE" >/dev/null 2>&1
}

has_currencies() { sfj data query --target-org "$1" --query 'SELECT COUNT() FROM CurrencyType' >/dev/null; }

# The clause that leaves person accounts out, where they exist.
business_only() { if has_person_accounts "$1"; then printf ' WHERE IsPersonAccount = false'; fi; }

# The records a SOQL query returns, as a JSON array.
records() {
  local out
  out=$(sfj data query --target-org "$1" --query "$2") || die "$1: query refused: $(sf_error "$out")"
  jq -c '.result.records' <<<"$out"
}

# The number a COUNT() query answers.
count() {
  local out
  out=$(sfj data query --target-org "$1" --query "$2") || die "$1: query refused: $(sf_error "$out")"
  jq -r '.result.totalSize' <<<"$out"
}

# One REST call through sf, so no token ever passes through this script.
# Leaves {"code": <HTTP status>, "body": <parsed body>} in RESPONSE; a call sf
# itself could not make answers code 0 with sf's message as its body.
call() {
  local org=$1 method=$2 path=$3 body=$4 header out
  shift 4
  local args=(api request rest "/services/data/$API/$path" --method "$method" --target-org "$org"
    --header 'Content-Type: application/json')
  # sf 2.152 refuses a DELETE that has no --body ("No 'mode' found in 'body'
  # entry"), and an empty --body too; a request file with a raw body of nothing
  # sends no body.
  if [[ -n $body ]]; then
    args+=(--body "$body")
  elif [[ $method != 'GET' ]]; then
    [[ -f $WORK/no-body.json ]] || printf '{"body":{"mode":"raw"}}' >"$WORK/no-body.json"
    args+=(--file "$WORK/no-body.json")
  fi
  for header in "$@"; do args+=(--header "$header"); done
  out=$(sfj "${args[@]}") || true
  [[ -n $out ]] || out='{}'
  RESPONSE=$(jq -c '{code: (.result.statusCode // 0), body: (.result.body // .message // null)}' \
    <<<"$out" 2>/dev/null || printf '{"code":0,"body":null}')
}

code_of() { jq -r '.code' <<<"$1"; }
id_of() { jq -r '.body.id? // empty' <<<"$1"; }

# The first error code a response carries: an sObject error's, an action's.
error_of() {
  jq -r '.body | if type == "array" then (.[0].errorCode // .[0].errors[0].statusCode // empty)
    elif type == "object" then (.errorCode // empty) else empty end' <<<"$1"
}

# POSTs a record and remembers it, so the end of the run removes it.
insert() {
  local org=$1 sobject=$2 body=$3 id
  shift 3
  call "$org" POST "sobjects/$sobject" "$body" "$@"
  id=$(id_of "$RESPONSE")
  if [[ -n $id ]]; then CREATED+=("$sobject/$id"); fi
}

# Deletes what insert remembered, newest first, so children go before parents.
# An item is let go by its box first: the before-delete flow refuses it else.
remove_created() {
  local org=$1 i sobject id
  for ((i = ${#CREATED[@]} - 1; i >= 0; i--)); do
    sobject=${CREATED[i]%%/*}
    id=${CREATED[i]#*/}
    if [[ $sobject == 'Trap_Item__c' ]]; then
      call "$org" PATCH "sobjects/Trap_Item__c/$id" '{"Trap_Allow_Delete__c":true}'
    fi
    call "$org" DELETE "sobjects/$sobject/$id" ''
  done
  CREATED=()
}

# --- connect --------------------------------------------------------------------

# A Developer Edition is signed up for by hand; this says whether each alias
# already leads to one, and how to log in where it does not.
connect_orgs() {
  local org missing=0
  for org in "$@"; do
    if [[ -n $(alias_user "$org") ]]; then
      (guard "$org") || exit 1
      say "$org: connected, a Developer Edition; person accounts $(has_person_accounts "$org" && printf on || printf off), multi-currency $(has_currencies "$org" && printf on || printf off)"
      continue
    fi
    missing=1
    say "$org: not connected. Sign up for a free Developer Edition at" \
      'https://developer.salesforce.com/signup, then log in with:'
    say "  sf org login web --alias $org --instance-url https://login.salesforce.com"
  done
  ((missing == 0)) || exit 1
}

# --- deploy ---------------------------------------------------------------------

# Deploys one folder of an SFDX project; on a refusal, prints each component's problem.
deploy_from() {
  local root=$1 org=$2 dir=$3 label=$4 out
  if out=$(cd "$root" && sfj project deploy start --target-org "$org" --source-dir "$dir" --wait 30); then
    say "$org: $label deployed"
    return 0
  fi
  say "$org: $label refused"
  jq -r '(.result.details.componentFailures // .data.details.componentFailures // empty)
    | (if type == "array" then .[] else . end)
    | "  \(.componentType // "?") \(.fullName // "?"): \(.problem // "?")"' <<<"$out" 2>/dev/null || true
  jq -e '.result.details.componentFailures // .data.details.componentFailures' <<<"$out" \
    >/dev/null 2>&1 || say "  $(sf_error "$out")"
  return 1
}

# A field deployed by the Metadata API stays hidden from every profile, the
# admin's included, until a permission set opens it.
assign_access() {
  local out
  out=$(sfj org assign permset --name Trap_Access --target-org "$1") || true
  if jq -e '.result.successes | length > 0' <<<"$out" >/dev/null 2>&1; then
    say "$1: Trap Access assigned to the admin"
  elif jq -r '.result.failures[]?.message' <<<"$out" 2>/dev/null | grep -qi 'duplicate'; then
    say "$1: Trap Access already assigned to the admin"
  else
    die "$1: Trap Access could not be assigned: $(sf_error "$out")"
  fi
}

# The active currencies, the corporate one marked. CurrencyType exists only
# where multi-currency is on, so a refused query says that and stops nothing.
currencies() {
  local out
  out=$(sfj data query --target-org "$1" --query \
    'SELECT IsoCode, IsCorporate FROM CurrencyType WHERE IsActive = true ORDER BY IsoCode') || {
    if [[ $(jq -r '.name // empty' <<<"$out" 2>/dev/null) == 'INVALID_TYPE' ]]; then
      printf 'none, multi-currency is off'
    else
      printf 'unread (%s)' "$(sf_error "$out" | head -n 1)"
    fi
    return 0
  }
  jq -r '.result.records | map(.IsoCode + (if .IsCorporate then " (corporate)" else "" end)) | join(", ")' <<<"$out"
}

report_currencies() { say "$1: active currencies: $(currencies "$1")"; }

# The source holds USD beside EUR; the target, EUR alone, refuses it.
activate_usd() {
  local org=$1 usd
  usd=$(records "$org" "SELECT Id, IsActive FROM CurrencyType WHERE IsoCode = 'USD'")
  if [[ $(jq 'length' <<<"$usd") == 0 ]]; then
    call "$org" POST sobjects/CurrencyType '{"IsoCode":"USD","ConversionRate":1.1,"DecimalPlaces":2,"IsActive":true}'
  elif [[ $(jq -r '.[0].IsActive' <<<"$usd") != 'true' ]]; then
    call "$org" PATCH "sobjects/CurrencyType/$(jq -r '.[0].Id' <<<"$usd")" '{"IsActive":true}'
  else
    return 0
  fi
  [[ $(code_of "$RESPONSE") == 20? ]] ||
    die "$org: USD not activated: HTTP $(code_of "$RESPONSE") $(error_of "$RESPONSE")"
  say "$org: USD activated"
}

# A matching rule activates in the background after its deploy, and a
# duplicate rule cannot use it before.
wait_matching_rules() {
  local org=$1 tries=0 states='' out
  while ((tries < 40)); do
    if out=$(sfj data query --target-org "$org" --query \
      "SELECT RuleStatus FROM MatchingRule WHERE DeveloperName IN ('Trap_Account_Name', 'Trap_Lead_Email')"); then
      states=$(jq -r '[.result.records[].RuleStatus] | join(",")' <<<"$out")
      [[ $states != 'Active,Active' ]] || return 0
      [[ $states != *Failed* ]] || die "$org: a matching rule failed to activate ($states)"
      if [[ $(jq '.result.records | length' <<<"$out") -lt 2 ]]; then
        say "$org: a matching rule is missing (${states:-none found}); trying the duplicate rules anyway"
        return 0
      fi
    fi
    tries=$((tries + 1))
    sleep 15
  done
  say "$org: matching rules still not active after 10 minutes (${states:-unknown}); trying the duplicate rules anyway"
}

# Each duplicate rule takes the place after the object's other rules. An org
# comes with standard duplicate rules, and how many depends on its features,
# so the sort order is set here rather than written in the file.
deploy_duplicate_rules() {
  local org=$1 project="$WORK/duplicates" file name object rule others
  mkdir -p "$project/rules/duplicateRules"
  printf '{"packageDirectories":[{"path":"rules","default":true}],"sourceApiVersion":"62.0"}\n' \
    >"$project/sfdx-project.json"
  for file in "$FIXTURE"/target/duplicates/duplicateRules/*.duplicateRule-meta.xml; do
    name=$(basename "$file" .duplicateRule-meta.xml)
    object=${name%%.*}
    rule=${name#*.}
    others=$(count "$org" \
      "SELECT COUNT() FROM DuplicateRule WHERE SobjectType = '$object' AND DeveloperName != '$rule'")
    sed "s#<sortOrder>[0-9]*</sortOrder>#<sortOrder>$((others + 1))</sortOrder>#" "$file" \
      >"$project/rules/duplicateRules/$name.duplicateRule-meta.xml"
  done
  deploy_from "$project" "$org" rules 'duplicate rules'
}

# Trap_Late__c leaves the target's deploy with X, Y and Z, and Trap_Empty with
# X alone. Retiring X then leaves Trap_Empty no active value: it refuses Y and
# Z while the UI API lists them for it, as a client record type did. Neither
# leaving the field out of the record type's file (it then gets every value)
# nor an entry without values (it changes nothing) gets there.
retire_late_value() {
  local org=$1 project="$WORK/retire"
  mkdir -p "$project/retire/objects/Case/fields"
  printf '{"packageDirectories":[{"path":"retire","default":true}],"sourceApiVersion":"62.0"}\n' \
    >"$project/sfdx-project.json"
  awk '/<value>/ { held = $0; next }
    held != "" { held = held "\n" $0; if (/<\/value>/) { if (held !~ /<fullName>X<\/fullName>/) print held; held = "" }; next }
    { print }' "$FIXTURE/target/main/default/objects/Case/fields/Trap_Late__c.field-meta.xml" \
    >"$project/retire/objects/Case/fields/Trap_Late__c.field-meta.xml"
  deploy_from "$project" "$org" retire 'Trap_Late__c without X'
}

deploy_source() {
  local org=$SOURCE_ORG
  deploy_from "$FIXTURE" "$org" source 'source metadata' || die "$org: deploy refused"
  assign_access "$org"
  if has_currencies "$org"; then activate_usd "$org"; fi
  report_currencies "$org"
}

deploy_target() {
  local org=$TARGET_ORG
  deploy_from "$FIXTURE" "$org" target/main 'target metadata' || die "$org: deploy refused"
  retire_late_value "$org" || die "$org: deploy refused"
  assign_access "$org"
  report_currencies "$org"
  wait_matching_rules "$org"
  deploy_duplicate_rules "$org" || say "$org: duplicate rules missing; verify says what that leaves"
  # New workflow rules are closed in Setup; whether the Metadata API still
  # takes one is what this deploy finds out, so a refusal is reported, not fatal.
  deploy_from "$FIXTURE" "$org" target/legacy 'workflow rule and email alert' ||
    say "$org: the Metadata API refused the workflow rule"
}

# --- seed -----------------------------------------------------------------------

# Runs a Bulk API 2.0 job on a CSV of the work folder; on failed rows, prints the first few.
bulk() {
  local operation=$1 org=$2 sobject=$3 file=$4 label=$5 out job
  if out=$(cd "$WORK" && sfj data "$operation" bulk --target-org "$org" --sobject "$sobject" \
    --file "$file" --line-ending LF --wait 20); then
    say "$org: $label: $(jq -r '.result.successfulRecords // .result.processedRecords // "?"' <<<"$out") rows"
    return 0
  fi
  say "$org: $label: $(sf_error "$out")"
  job=$(jq -r '.data.jobId // empty' <<<"$out" 2>/dev/null || true)
  if [[ -n $job ]]; then
    (cd "$WORK" && sfj data bulk results --job-id "$job" --target-org "$org" >/dev/null) || true
    if [[ -f "$WORK/$job-failed-records.csv" ]]; then
      say '  first refused rows:'
      sed -n '2,4p' "$WORK/$job-failed-records.csv" | cut -c1-240 | sed 's/^/  /'
    fi
  fi
  return 1
}

record_type() {
  records "$1" "SELECT Id FROM RecordType WHERE SobjectType = '$2' AND DeveloperName = '$3'" |
    jq -r '.[0].Id // empty'
}

# The person (true) or business (false) record type of Account.
account_record_type() {
  records "$1" "SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND IsActive = true
    AND IsPersonType = $2 ORDER BY DeveloperName LIMIT 1" | jq -r '.[0].Id // empty'
}

# A number in the ARCEP fiction range +33 6 39 98 XX XX, written the way the
# target's phone rule takes.
# Every generator below writes into that range: accounts from 9001, person
# accounts from 9101, contacts from 1, probes from 9901.
readonly AWK_PHONE='function phone(n) { return sprintf("+33 6 39 98 %02d %02d", int(n / 100), n % 100) }'

# Forty business accounts. Rows 31-40 repeat the names of rows 1-10 (the
# target alerts on a duplicate name) and the external ids of rows 11-20 (the
# target's is unique). Odd rows are Customers, even rows Prospects (the
# target's lookup filter takes Customers only); every fourth is in USD.
gen_business_accounts() {
  awk -v rt="$1" -v cur="$2" "$AWK_PHONE"'
    BEGIN {
      print "Name,Type,Trap_Ext_Id__c,Phone" (cur ? ",CurrencyIsoCode" : "") (rt != "" ? ",RecordTypeId" : "")
      for (i = 1; i <= 40; i++) {
        printf "Trap Account %02d,%s,TRAP-EXT-%03d,%s%s%s\n", (i <= 30 ? i : i - 30),
          (i % 2 ? "Customer" : "Prospect"), (i <= 30 ? i : i - 20), phone(9000 + i),
          (cur ? (i % 4 ? ",EUR" : ",USD") : ""), (rt != "" ? "," rt : "")
      }
    }'
}

gen_person_accounts() {
  awk -v rt="$1" -v cur="$2" "$AWK_PHONE"'
    BEGIN {
      print "FirstName,LastName,PersonEmail,PersonMobilePhone" (cur ? ",CurrencyIsoCode" : "") ",RecordTypeId"
      for (i = 1; i <= 10; i++) {
        printf "Trap,Person %02d,trap.person.%02d@example.invalid,%s%s,%s\n", i, i,
          phone(9100 + i), (cur ? (i % 3 ? ",EUR" : ",USD") : ""), rt
      }
    }'
}

# $CONTACTS contacts, for a DataOps run past what its backup reads. One in 25 has no
# email (the target requires one), and the phones come in four shapes: the
# format the target's rule takes, the national form and a compact form it
# refuses, and none. One in ten points its preferred account at a Prospect,
# which the target's lookup filter refuses.
gen_contacts() {
  awk -F '\t' -v total="$CONTACTS" "$AWK_PHONE"'
    { ids[++n] = $1; if ($2 == "Customer") customers[++nc] = $1; else prospects[++np] = $1 }
    END {
      print "FirstName,LastName,Email,Phone,AccountId,Trap_Preferred_Account__c"
      for (i = 1; i <= total; i++) {
        email = i % 25 ? sprintf("trap.contact.%04d@example.invalid", i) : ""
        shape = i % 5
        if (shape == 1) tel = sprintf("06 39 98 %02d %02d", int(i / 100), i % 100)
        else if (shape == 2) tel = sprintf("+3363998%04d", i)
        else if (shape == 3) tel = ""
        else tel = phone(i)
        preferred = ""
        if (i % 10 == 0 && np) preferred = prospects[(i / 10) % np + 1]
        else if (i % 10 == 5 && nc) preferred = customers[int(i / 10) % nc + 1]
        printf "Trap,Contact %04d,%s,%s,%s,%s\n", i, email, tel, ids[(i - 1) % n + 1], preferred
      }
    }' "$WORK/parents.tsv"
}

# Forty cases, alternating the two record types and cycling A, B, C and X, Y,
# Z, so the target refuses C on Trap_Main, X everywhere and every
# Trap_Late__c value on Trap_Empty; one pair in two breaks the target's
# dependency.
gen_cases() {
  awk -F '\t' -v main="$1" -v empty="$2" '
    { ids[++n] = $1 }
    END {
      split("Hardware,Software,Software,Hardware", category, ",")
      split("Laptop,Laptop,Bug,License", subcategory, ",")
      print "RecordTypeId,Subject,Status,Origin,Trap_Reason__c,Trap_Late__c,Trap_Category__c,Trap_Subcategory__c,AccountId"
      for (i = 1; i <= 40; i++) {
        k = (i - 1) % 4 + 1
        printf "%s,Trap Case %02d,New,Web,%s,%s,%s,%s,%s\n", (i % 2 ? main : empty), i,
          substr("ABC", (i - 1) % 3 + 1, 1), substr("XYZ", int((i - 1) / 2) % 3 + 1, 1),
          category[k], subcategory[k], ids[(i - 1) % n + 1]
      }
    }' "$WORK/parents.tsv"
}

gen_items() {
  awk -F '\t' -v cur="$1" '
    { ids[++n] = $1 }
    END {
      split("Hardware,Software,Software,Hardware", category, ",")
      split("Laptop,Laptop,Bug,License", subcategory, ",")
      print "Name,Trap_Category__c,Trap_Subcategory__c,Trap_Account__c" (cur ? ",CurrencyIsoCode" : "")
      for (i = 1; i <= 40; i++) {
        k = (i - 1) % 4 + 1
        printf "Trap Item %02d,%s,%s,%s%s\n", i, category[k], subcategory[k],
          ids[(i - 1) % n + 1], (cur ? (i % 4 ? ",EUR" : ",USD") : "")
      }
    }' "$WORK/parents.tsv"
}

# Leads by email, and with twins (1) a second lead on each email that shares
# nothing else with the first: no name or company in common, so the org's
# standard matching rules leave the pair be and only the target's email rule
# blocks the second.
gen_leads() {
  awk -v count="$1" -v twins="$2" '
    BEGIN {
      print "FirstName,LastName,Company,Email"
      for (k = 1; k <= count; k++) {
        printf "Trap,Lead %02d,Trap Company %02d,trap.lead.%02d@example.invalid\n", k, k, k
        if (twins) printf "Other,Prospect %02d,Trap Other Company %02d,trap.lead.%02d@example.invalid\n", k, k, k
      }
    }'
}

seed_source() {
  local org=$SOURCE_ORG seeded business='' person='' main empty cur=0
  seeded=$(count "$org" "SELECT COUNT() FROM Contact WHERE Email LIKE '%@example.invalid'")
  [[ $seeded == 0 ]] || die "$org: already seeded; run wipe source first"
  if has_person_accounts "$org"; then
    person=$(account_record_type "$org" true)
    business=$(account_record_type "$org" false)
  else
    say "$org: person accounts off, none seeded"
  fi
  if has_currencies "$org"; then cur=1; else say "$org: multi-currency off, every record in the org's currency"; fi
  main=$(record_type "$org" Case Trap_Main)
  empty=$(record_type "$org" Case Trap_Empty)
  [[ -n $main && -n $empty ]] || die "$org: the Case record types are missing; run deploy source first"

  gen_business_accounts "$business" "$cur" >"$WORK/accounts.csv"
  bulk import "$org" Account accounts.csv 'business accounts' || die "$org: seed stopped"
  if [[ -n $person ]]; then
    gen_person_accounts "$person" "$cur" >"$WORK/person-accounts.csv"
    bulk import "$org" Account person-accounts.csv 'person accounts' || die "$org: seed stopped"
  fi

  # Only the seeded accounts parent the rest: a Developer Edition comes with
  # sample accounts of its own.
  records "$org" "SELECT Id, Type FROM Account WHERE Name LIKE 'Trap Account %' ORDER BY Name, Trap_Ext_Id__c" |
    jq -r '.[] | [.Id, .Type] | @tsv' >"$WORK/parents.tsv"
  gen_contacts >"$WORK/contacts.csv"
  bulk import "$org" Contact contacts.csv contacts || die "$org: seed stopped"
  gen_cases "$main" "$empty" >"$WORK/cases.csv"
  bulk import "$org" Case cases.csv cases || die "$org: seed stopped"
  gen_items "$cur" >"$WORK/items.csv"
  bulk import "$org" Trap_Item__c items.csv 'trap items' || die "$org: seed stopped"
  gen_leads 10 1 >"$WORK/leads.csv"
  bulk import "$org" Lead leads.csv leads || die "$org: seed stopped"
}

# The target starts with what makes its duplicate traps fire on a single
# clone: duplicate rules compare a record with those already saved, not with
# the others of its own batch. Three accounts share their names and external
# ids with source accounts, two leads their emails with source leads.
seed_target() {
  local org=$TARGET_ORG seeded business=''
  seeded=$(count "$org" "SELECT COUNT() FROM Account WHERE Name LIKE 'Trap Account %'")
  [[ $seeded == 0 ]] || die "$org: already seeded; run wipe target first"
  if has_person_accounts "$org"; then business=$(account_record_type "$org" false); fi
  awk -v rt="$business" 'BEGIN {
    print "Name,Type,Trap_Ext_Id__c,Trap_Target_Only__c" (rt != "" ? ",RecordTypeId" : "")
    for (i = 1; i <= 3; i++)
      printf "Trap Account %02d,Customer,TRAP-EXT-%03d,seeded in the target%s\n", i, i, (rt != "" ? "," rt : "")
  }' >"$WORK/target-accounts.csv"
  bulk import "$org" Account target-accounts.csv 'accounts already in the target' || die "$org: seed stopped"
  gen_leads 2 0 >"$WORK/target-leads.csv"
  bulk import "$org" Lead target-leads.csv 'leads already in the target' || die "$org: seed stopped"
}

# --- wipe -----------------------------------------------------------------------

# Deletes every record a query returns, through Bulk API 2.0.
wipe_query() {
  local org=$1 sobject=$2 query=$3 file="wipe-$2.csv"
  records "$org" "$query" | jq -r '"Id", (.[].Id)' >"$WORK/$file"
  if (($(wc -l <"$WORK/$file") < 2)); then
    say "$org: no $sobject to remove"
    return 0
  fi
  bulk delete "$org" "$sobject" "$file" "$sobject removed" || die "$org: wipe stopped"
}

# Back to an empty org, children before parents. The sample records a
# Developer Edition comes with go too: these orgs serve SandForge alone, and
# their 5 MB are better spent on the seed.
wipe_org() {
  local org=$1
  if [[ $org == "$TARGET_ORG" ]]; then
    records "$org" 'SELECT Id FROM Trap_Item__c WHERE Trap_Allow_Delete__c = false' |
      jq -r '"Id,Trap_Allow_Delete__c", (.[] | .Id + ",true")' >"$WORK/unlock.csv"
    if (($(wc -l <"$WORK/unlock.csv") > 1)); then
      bulk update "$org" Trap_Item__c unlock.csv 'trap items let go by the delete flow' || die "$org: wipe stopped"
    fi
  fi
  wipe_query "$org" Case 'SELECT Id FROM Case'
  wipe_query "$org" Trap_Item__c 'SELECT Id FROM Trap_Item__c'
  wipe_query "$org" Contact "SELECT Id FROM Contact$(business_only "$org")"
  wipe_query "$org" Lead 'SELECT Id FROM Lead'
  wipe_query "$org" Opportunity 'SELECT Id FROM Opportunity'
  wipe_query "$org" Account 'SELECT Id FROM Account'
}

# --- verify ---------------------------------------------------------------------

# One line per probe: org, trap, what was sent, the HTTP status and error code
# it got. With an expected status, a different one is flagged and fails the run.
report() {
  local side=$1 trap=$2 label=$3 expected=$4 response=$5 note=${6:-} got err mark=''
  got=$(code_of "$response")
  err=$(error_of "$response")
  if [[ -n $expected && $got != "$expected" ]]; then
    mark="  UNEXPECTED, expected $expected"
    UNEXPECTED=$((UNEXPECTED + 1))
  fi
  printf '%-6s %-4s %-58s HTTP %s %s%s%s\n' "$side" "$trap" "$label" "$got" "${err:--}" \
    "${note:+  ($note)}" "$mark"
}

note() { printf '%-6s %-4s %-58s %s\n' "$1" "$2" "$3" "$4"; }

owner_kind() {
  call "$1" GET "sobjects/Lead/$2?fields=OwnerId" ''
  case $(jq -r '.body.OwnerId? // ""' <<<"$RESPONSE") in
    00G*) printf 'owner: a queue' ;;
    005*) printf 'owner: a user' ;;
    *) printf 'owner: unread' ;;
  esac
}

verify_source() {
  local org=$SOURCE_ORG
  note source S1 'contacts, person accounts aside' \
    "$(count "$org" "SELECT COUNT() FROM Contact$(business_only "$org")")"
  if has_person_accounts "$org"; then
    note source S2 'business accounts / person accounts' \
      "$(count "$org" 'SELECT COUNT() FROM Account WHERE IsPersonAccount = false') / $(count "$org" 'SELECT COUNT() FROM Account WHERE IsPersonAccount = true')"
  else
    note source S2 'accounts (person accounts off)' "$(count "$org" 'SELECT COUNT() FROM Account')"
  fi
  note source S3 'cases on Trap_Main / Trap_Empty' \
    "$(count "$org" "SELECT COUNT() FROM Case WHERE RecordType.DeveloperName = 'Trap_Main'") / $(count "$org" "SELECT COUNT() FROM Case WHERE RecordType.DeveloperName = 'Trap_Empty'")"
  note source S4 'cases with Trap_Reason__c C / Trap_Late__c X / pairs the target refuses' \
    "$(count "$org" "SELECT COUNT() FROM Case WHERE Trap_Reason__c = 'C'") / $(count "$org" "SELECT COUNT() FROM Case WHERE Trap_Late__c = 'X'") / $(count "$org" "SELECT COUNT() FROM Case WHERE (Trap_Category__c = 'Software' AND Trap_Subcategory__c IN ('Laptop', 'Printer')) OR (Trap_Category__c = 'Hardware' AND Trap_Subcategory__c IN ('License', 'Bug'))")"
  note source S5 'trap items' "$(count "$org" 'SELECT COUNT() FROM Trap_Item__c')"
  note source S6 'leads / emails two leads share' \
    "$(count "$org" 'SELECT COUNT() FROM Lead') / $(records "$org" 'SELECT Email FROM Lead GROUP BY Email HAVING COUNT(Id) > 1' | jq 'length')"
  note source S7 'external ids two accounts share' \
    "$(records "$org" 'SELECT Trap_Ext_Id__c FROM Account WHERE Trap_Ext_Id__c != null GROUP BY Trap_Ext_Id__c HAVING COUNT(Id) > 1' | jq 'length')"
  note source S8 'active currencies' "$(currencies "$org")"
}

verify_target() {
  local org=$TARGET_ORG main empty person='' business='' described account_rt base id response
  CLEANUP_ORG=$org
  main=$(record_type "$org" Case Trap_Main)
  empty=$(record_type "$org" Case Trap_Empty)
  [[ -n $main && -n $empty ]] || die "$org: the Case record types are missing; run deploy target first"
  call "$org" GET sobjects/Account/describe ''
  described=$RESPONSE
  if jq -e '.body.fields | map(.name) | index("IsPersonAccount")' <<<"$described" >/dev/null 2>&1; then
    person=$(account_record_type "$org" true)
    business=$(account_record_type "$org" false)
  fi
  account_rt=${business:+,\"RecordTypeId\":\"$business\"}
  # Every account the probes write carries the field the target alone requires.
  base='"Trap_Target_Only__c":"probe"'"$account_rt"

  # 1. Record types and a restricted picklist.
  insert "$org" Case "{\"RecordTypeId\":\"$main\",\"Subject\":\"Trap probe\",\"Status\":\"New\",\"Trap_Reason__c\":\"C\"}"
  report target 1a 'Case Trap_Main, Trap_Reason__c C (not given)' 400 "$RESPONSE"
  insert "$org" Case "{\"RecordTypeId\":\"$main\",\"Subject\":\"Trap probe\",\"Status\":\"New\",\"Trap_Reason__c\":\"A\"}"
  report target 1b 'Case Trap_Main, Trap_Reason__c A (given, control)' 201 "$RESPONSE"
  insert "$org" Case "{\"RecordTypeId\":\"$empty\",\"Subject\":\"Trap probe\",\"Status\":\"New\",\"Trap_Late__c\":\"Y\"}"
  report target 1c 'Case Trap_Empty, Trap_Late__c Y (no active value left)' 400 "$RESPONSE"
  call "$org" GET "ui-api/object-info/Case/picklist-values/$empty/Trap_Late__c" ''
  report target 1d 'UI API values of Trap_Late__c for Trap_Empty' 200 "$RESPONSE" \
    "lists $(jq -r '[.body.values[]?.value] | if length == 0 then "none" else join(", ") end' <<<"$RESPONSE")"
  insert "$org" Case "{\"RecordTypeId\":\"$main\",\"Subject\":\"Trap probe\",\"Status\":\"New\",\"Trap_Late__c\":\"X\"}"
  report target 1e 'Case Trap_Main, Trap_Late__c X (retired)' 400 "$RESPONSE"

  # 2. Dependent picklists, with and without record types.
  insert "$org" Case "{\"RecordTypeId\":\"$main\",\"Subject\":\"Trap probe\",\"Status\":\"New\",\"Trap_Category__c\":\"Software\",\"Trap_Subcategory__c\":\"Laptop\"}"
  report target 2a 'Case Trap_Main, Software with Laptop' '' "$RESPONSE"
  insert "$org" Trap_Item__c '{"Name":"Trap probe","Trap_Category__c":"Software","Trap_Subcategory__c":"Laptop"}'
  report target 2b 'Trap_Item__c (no record type), Software with Laptop' '' "$RESPONSE"
  call "$org" GET sobjects/Trap_Item__c/describe ''
  report target 2c 'Trap_Item__c describe: Trap_Subcategory__c' 200 "$RESPONSE" \
    "$(jq -r '.body.fields[]? | select(.name == "Trap_Subcategory__c")
      | "dependent: \(.dependentPicklist), controller: \(.controllerName), validFor on \([.picklistValues[] | select(.validFor != null)] | length) of \(.picklistValues | length)"' <<<"$RESPONSE")"

  # 3. Validation rules on Contact.
  insert "$org" Contact '{"LastName":"Probe Phone","Email":"trap.probe.phone@example.invalid","Phone":"06 39 98 99 01"}'
  report target 3a 'Contact, phone in the national form' 400 "$RESPONSE"
  insert "$org" Contact '{"LastName":"Probe Email","Phone":"+33 6 39 98 99 02"}'
  report target 3b 'Contact without email (bypassable rule)' 400 "$RESPONSE"
  note target 3c 'Trap Bypass assignments' \
    "$(count "$org" "SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSet.Name = 'Trap_Bypass'")"

  # 4. Duplicate rules: an alert lets the API through only with allowSave, a block never.
  insert "$org" Account "{\"Name\":\"Trap Probe Twin\",$base}"
  report target 4a 'Account, first of a name (control)' 201 "$RESPONSE"
  insert "$org" Account "{\"Name\":\"Trap Probe Twin\",$base}"
  report target 4b 'Account, same name, no duplicate header (alert)' 400 "$RESPONSE"
  insert "$org" Account "{\"Name\":\"Trap Probe Twin\",$base}" 'Sforce-Duplicate-Rule-Header: allowSave=true'
  report target 4c 'Account, same name, allowSave=true (alert)' 201 "$RESPONSE"
  insert "$org" Lead '{"LastName":"Probe Twin","Company":"Trap Probe","Email":"trap.probe.twin@example.invalid"}'
  report target 4d 'Lead, first of an email (control)' 201 "$RESPONSE"
  insert "$org" Lead '{"LastName":"Probe Other","Company":"Trap Probe Other","Email":"trap.probe.twin@example.invalid"}'
  report target 4e 'Lead, same email, no duplicate header (block)' 400 "$RESPONSE"
  insert "$org" Lead '{"LastName":"Probe Other","Company":"Trap Probe Other","Email":"trap.probe.twin@example.invalid"}' \
    'Sforce-Duplicate-Rule-Header: allowSave=true'
  report target 4f 'Lead, same email, allowSave=true (block)' 400 "$RESPONSE"

  # 5. A required lookup filter.
  insert "$org" Account "{\"Name\":\"Trap Probe Prospect\",\"Type\":\"Prospect\",$base}"
  id=$(id_of "$RESPONSE")
  insert "$org" Contact "{\"LastName\":\"Probe Filter\",\"Email\":\"trap.probe.filter@example.invalid\",\"Trap_Preferred_Account__c\":\"$id\"}"
  report target 5 'Contact preferring a Prospect account' 400 "$RESPONSE"

  # 6 and 7. A field required in the target only; a unique external id.
  insert "$org" Account "{\"Name\":\"Trap Probe Missing\"$account_rt}"
  report target 6 'Account without Trap_Target_Only__c' 400 "$RESPONSE"
  insert "$org" Account "{\"Name\":\"Trap Probe Unique One\",\"Trap_Ext_Id__c\":\"TRAP-PROBE-UNIQUE\",$base}"
  report target 7a 'Account with an external id (control)' 201 "$RESPONSE"
  insert "$org" Account "{\"Name\":\"Trap Probe Unique Two\",\"Trap_Ext_Id__c\":\"TRAP-PROBE-UNIQUE\",$base}"
  report target 7b 'Account with the same external id' 400 "$RESPONSE"

  # 8. A before-delete flow that refuses the delete.
  call "$org" POST sobjects/Trap_Item__c '{"Name":"Trap probe delete"}'
  id=$(id_of "$RESPONSE")
  if [[ -n $id ]]; then
    call "$org" DELETE "sobjects/Trap_Item__c/$id" ''
    report target 8a 'Trap_Item__c delete' 400 "$RESPONSE"
    call "$org" PATCH "sobjects/Trap_Item__c/$id" '{"Trap_Allow_Delete__c":true}'
    call "$org" DELETE "sobjects/Trap_Item__c/$id" ''
    report target 8b 'Trap_Item__c delete once let go' 204 "$RESPONSE"
    [[ $(code_of "$RESPONSE") == 204 ]] || CREATED+=("Trap_Item__c/$id")
  else
    report target 8a 'Trap_Item__c insert for the delete probe' 201 "$RESPONSE"
  fi

  # 9. Automation that sends messages.
  insert "$org" Contact '{"LastName":"Probe Message","Email":"trap.probe.message@example.invalid","Phone":"+33 6 39 98 99 09"}'
  report target 9a 'Contact with an email (flow sends two emails)' '' "$RESPONSE"
  note target 9b 'active flows: welcome email / refuse delete' \
    "$(count "$org" "SELECT COUNT() FROM FlowDefinitionView WHERE ApiName = 'Trap_Contact_Welcome_Email' AND IsActive = true") / $(count "$org" "SELECT COUNT() FROM FlowDefinitionView WHERE ApiName = 'Trap_Item_Refuse_Delete' AND IsActive = true")"
  response=$(sfj data query --use-tooling-api --target-org "$org" \
    --query "SELECT Id FROM WorkflowRule WHERE Name = 'Trap_Contact_Welcome'" || true)
  note target 9c 'workflow rule with an email alert' \
    "$(jq -r 'if .result.totalSize > 0 then "deployed" elif .result then "absent: the deploy was refused" else "unread" end' <<<"$response" 2>/dev/null || printf 'unread')"

  # 10. An active assignment rule on Lead.
  insert "$org" Lead '{"LastName":"Probe Assign","Company":"Trap Probe","Email":"trap.probe.assign@example.invalid"}'
  id=$(id_of "$RESPONSE")
  report target 10a 'Lead, REST default' 201 "$RESPONSE" "${id:+$(owner_kind "$org" "$id")}"
  insert "$org" Lead '{"LastName":"Probe Keep","Company":"Trap Probe","Email":"trap.probe.keep@example.invalid"}' \
    'Sforce-Auto-Assign: FALSE'
  id=$(id_of "$RESPONSE")
  report target 10b 'Lead, Sforce-Auto-Assign FALSE' 201 "$RESPONSE" "${id:+$(owner_kind "$org" "$id")}"

  # 11. Person accounts.
  report target 11a 'Account describe: IsPersonAccount field' 200 "$described" \
    "$(if [[ -n $person ]]; then printf 'person accounts on'; else printf 'person accounts OFF'; fi)"
  if [[ -n $person ]]; then
    insert "$org" Account "{\"RecordTypeId\":\"$person\",\"FirstName\":\"Probe\",\"LastName\":\"Person\",\"PersonEmail\":\"trap.probe.person@example.invalid\",\"Trap_Target_Only__c\":\"probe\"}"
    report target 11b 'Person account' 201 "$RESPONSE"
  fi

  # 12. Multi-currency: EUR alone in the target. Without multi-currency the
  # field does not exist, and a 400 for that would prove nothing.
  note target 12a 'active currencies' "$(currencies "$org")"
  if has_currencies "$org"; then
    insert "$org" Account "{\"Name\":\"Trap Probe Dollar\",\"CurrencyIsoCode\":\"USD\",$base}"
    report target 12b 'Account in USD' 400 "$RESPONSE"
  fi

  # 13. Deliverability, as the Send Email action meets it.
  call "$org" POST actions/standard/emailSimple \
    '{"inputs":[{"emailAddresses":"trap.probe.deliverability@example.invalid","emailSubject":"Trap probe","emailBody":"A synthetic message from the SandForge trap org."}]}'
  report target 13 'Send Email action' '' "$RESPONSE" \
    "$(jq -r '.body | if type == "array" then "isSuccess: \(.[0].isSuccess)\(if .[0].errors then ", " + (.[0].errors | map(.message) | join("; ")) else "" end)" else empty end' <<<"$RESPONSE" 2>/dev/null || true)"

  remove_created "$org"
}

# --- main -----------------------------------------------------------------------

main() {
  local action=${1:-} side=${2:-} org started=$SECONDS orgs=()
  case $side in
    '') orgs=("$SOURCE_ORG" "$TARGET_ORG") ;;
    source) orgs=("$SOURCE_ORG") ;;
    target) orgs=("$TARGET_ORG") ;;
    *) usage ;;
  esac
  command -v sf >/dev/null || die 'the Salesforce CLI (sf) is not on the PATH'
  command -v jq >/dev/null || die 'jq is not on the PATH'
  case $action in
    connect) connect_orgs "${orgs[@]}" ;;
    deploy | seed | verify | wipe)
      for org in "${orgs[@]}"; do guard "$org"; done
      for org in "${orgs[@]}"; do
        case $action in
          deploy) if [[ $org == "$SOURCE_ORG" ]]; then deploy_source; else deploy_target; fi ;;
          seed) if [[ $org == "$SOURCE_ORG" ]]; then seed_source; else seed_target; fi ;;
          verify) if [[ $org == "$SOURCE_ORG" ]]; then verify_source; else verify_target; fi ;;
          wipe) wipe_org "$org" ;;
        esac
      done
      ;;
    *) usage ;;
  esac
  say "trap-org: $action took $((SECONDS - started)) s"
  if ((UNEXPECTED > 0)); then die "$UNEXPECTED probe(s) answered other than expected"; fi
}

main "$@"
