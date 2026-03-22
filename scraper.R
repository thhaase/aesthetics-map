# ============================================================================
# Aesthetics Wiki Scraper
# Scrapes all aesthetics from https://aesthetics.fandom.com/wiki/List_of_Aesthetics
# Uses the MediaWiki API to extract article text + infobox data
# ============================================================================

library(httr)
library(XML)
library(stringr)
library(tidyverse)
library(jsonlite)

# --- CONFIG ---
base_url    <- "https://aesthetics.fandom.com"
api_url     <- paste0(base_url, "/api.php")
output_path <- "aesthetics_wiki_data.csv"
delay       <- 2  # seconds between requests (be polite)

# =============================================================================
# STEP 1: Get all internal links from the List of Aesthetics page
# =============================================================================
cat("── Step 1: Fetching list of aesthetics from wiki ──\n")

response <- GET(api_url, query = list(
  action = "parse",
  page   = "List_of_Aesthetics",
  prop   = "links",
  format = "json"
))
response$status_code

list_data    <- content(response, as = "text", encoding = "UTF-8")
list_json    <- fromJSON(list_data, simplifyVector = FALSE)
raw_links    <- list_json$parse$links

# Extract page titles from the links (namespace 0 = main articles)
aesthetic_titles <- c()
for (link in raw_links) {
  if (!is.null(link$ns) && link$ns == 0) {
    aesthetic_titles <- c(aesthetic_titles, link[["*"]])
  }
}

# Filter out known meta/non-aesthetic pages
meta_pages <- c(
  "List_of_Aesthetics", "List of Aesthetics",
  "Aesthetics Wiki", "Aesthetics_Wiki",
  "Aesthetics 101", "Aesthetics_101",
  "FAQ", "Rules", "Page Standards", "Page_Standards",
  "Allowed Pages", "Allowed_Pages",
  "Format and Content", "Format_and_Content",
  "Formatting Tutorials", "Formatting_Tutorials",
  "Citing Sources", "Citing_Sources",
  "Pages We Need", "Pages_We_Need",
  "List of Deleted Pages and Why",
  "Helping You Find Your Aesthetic",
  "Glossary", "Criticism of Aesthetics",
  "Differences Between Similar Aesthetics",
  "Wiki Staff", "By Color", "By Decade", "By Adjective", "By Category",
  "Find Aesthetic by Image", "Aesthetic Visual Index",
  "Nostalgia", "Microgenre", "Art movement"
)
aesthetic_titles <- aesthetic_titles[!aesthetic_titles %in% meta_pages]
aesthetic_titles <- unique(aesthetic_titles)

cat(sprintf("Found %d aesthetic pages to scrape.\n", length(aesthetic_titles)))

# =============================================================================
# STEP 2: Define all known infobox fields
# =============================================================================
# Source: https://aesthetics.fandom.com/wiki/Aesthetics_Wiki:Page_Standards
# The infobox template {{Aesthetic}} uses these fields.
# HTML labels may differ slightly from wikitext param names, so we map
# every known variant to a clean column name.

infobox_label_map <- c(
  # --- Core identity ---
  "Other names"               = "other_names",
  "Decade of origin"          = "decade_of_origin",
  "Location of origin"        = "location_of_origin",
  "Creator(s)"                = "creators",
  "Creator/s"                 = "creators",
  "Creators"                  = "creators",
  "Coined by"                 = "coined_by",
  # --- Visual / thematic ---
  "Key motifs"                = "key_motifs",
  "Key colours"               = "key_colours",
  "Key colors"                = "key_colours",
  "Key values"                = "key_values",
  # --- Connections ---
  "Related aesthetics"        = "related_aesthetics",
  "Subgenres"                 = "subgenres",
  "Subgenres and derivatives" = "subgenres",
  # --- Platform / media ---
  "Primary platform"          = "primary_platform",
  "Related media"             = "related_media",
  "Related brands"            = "related_brands",
  "Iconic figures"            = "iconic_figures",
  # --- Timeline ---
  "Preceded by"               = "preceded_by",
  "Succeeded by"              = "succeeded_by",
  "Overlaps with"             = "overlaps_with",
  "Contemporaries"            = "overlaps_with"
)

# All unique column names we want in the output
infobox_columns <- unique(infobox_label_map)

# =============================================================================
# STEP 3: Define parsing functions
# =============================================================================

# --- Parse the portable infobox from the HTML ---
# Fandom uses "portable infoboxes": <aside class="portable-infobox">
#   Labels:  <h3 class="pi-data-label">
#   Values:  <div class="pi-data-value">
#
# Connection fields (related_aesthetics, subgenres, preceded_by, etc.)
# contain <a> links separated by <br> tags.
# We extract each <a> text individually and join with "; "

parse_infobox <- function(dom) {
  infobox <- list()
  
  # Get all <div class="pi-item pi-data"> containers from portable infobox
  items <- getNodeSet(
    dom,
    '//aside[contains(@class,"portable-infobox")]//div[contains(@class,"pi-item") and contains(@class,"pi-data")]'
  )
  
  if (length(items) == 0) {
    # Fallback: table-based infobox (rare on Fandom, but just in case)
    labels <- xpathSApply(dom, '//table[contains(@class,"infobox")]//th', xmlValue)
    values <- xpathSApply(dom, '//table[contains(@class,"infobox")]//td', xmlValue)
    if (length(labels) > 0 && length(values) > 0) {
      n <- min(length(labels), length(values))
      for (i in seq_len(n)) {
        key <- str_trim(labels[i])
        val <- str_replace_all(str_trim(values[i]), "\\s+", " ")
        infobox[[key]] <- val
      }
    }
    return(infobox)
  }
  
  for (item in items) {
    # Extract label
    label_nodes <- getNodeSet(item, './/h3[contains(@class,"pi-data-label")]')
    if (length(label_nodes) == 0) next
    label <- str_trim(xmlValue(label_nodes[[1]]))
    
    # Extract value node
    value_nodes <- getNodeSet(item, './/div[contains(@class,"pi-data-value")]')
    if (length(value_nodes) == 0) next
    value_node <- value_nodes[[1]]
    
    # For connection fields: extract individual <a> link texts
    links <- getNodeSet(value_node, './/a')
    if (length(links) > 1) {
      link_texts <- sapply(links, xmlValue)
      link_texts <- str_trim(link_texts)
      link_texts <- link_texts[link_texts != ""]
      val <- paste(link_texts, collapse = "; ")
    } else {
      val <- xmlValue(value_node)
      val <- str_replace_all(str_trim(val), "\\s+", " ")
    }
    
    infobox[[label]] <- val
  }
  
  # Also check timeline section (sometimes in a separate pi-group/section)
  timeline_items <- getNodeSet(
    dom,
    '//aside[contains(@class,"portable-infobox")]//section[contains(@class,"pi-group")]//div[contains(@class,"pi-item") and contains(@class,"pi-data")]'
  )
  for (item in timeline_items) {
    label_nodes <- getNodeSet(item, './/h3[contains(@class,"pi-data-label")]')
    if (length(label_nodes) == 0) next
    label <- str_trim(xmlValue(label_nodes[[1]]))
    if (label %in% names(infobox)) next  # already captured
    
    value_nodes <- getNodeSet(item, './/div[contains(@class,"pi-data-value")]')
    if (length(value_nodes) == 0) next
    value_node <- value_nodes[[1]]
    
    links <- getNodeSet(value_node, './/a')
    if (length(links) >= 1) {
      link_texts <- sapply(links, xmlValue)
      link_texts <- str_trim(link_texts)
      link_texts <- link_texts[link_texts != ""]
      val <- paste(link_texts, collapse = "; ")
    } else {
      val <- str_replace_all(str_trim(xmlValue(value_node)), "\\s+", " ")
    }
    infobox[[label]] <- val
  }
  
  return(infobox)
}

# --- Extract clean article text from the HTML ---
parse_article_text <- function(dom) {
  paragraphs <- xpathSApply(
    dom,
    '//div[contains(@class,"mw-parser-output")]/p',
    xmlValue
  )
  article_text <- paste(paragraphs, collapse = "\n\n")
  article_text <- str_trim(article_text)
  article_text <- str_replace_all(article_text, "\\[\\d+\\]", "")
  article_text <- str_replace_all(article_text, "\\n{3,}", "\n\n")
  return(article_text)
}

# =============================================================================
# STEP 4: Loop through each aesthetic and scrape
# =============================================================================
cat("── Step 2: Scraping individual aesthetic pages ──\n")

results <- list()

for (i in seq_along(aesthetic_titles)) {
  title <- aesthetic_titles[i]
  cat(sprintf("[%d/%d] Scraping: %s\n", i, length(aesthetic_titles), title))
  
  tryCatch({
    resp <- GET(api_url, query = list(
      action  = "parse",
      page    = title,
      prop    = "text|categories",
      format  = "json"
    ))
    
    if (resp$status_code != 200) {
      cat(sprintf("  ⚠ HTTP %d, skipping.\n", resp$status_code))
      next
    }
    
    page_data <- content(resp, as = "text", encoding = "UTF-8")
    page_json <- fromJSON(page_data, simplifyVector = FALSE)
    
    if (!is.null(page_json$error)) {
      cat(sprintf("  ⚠ API error: %s, skipping.\n", page_json$error$info))
      next
    }
    
    html_content <- page_json$parse$text[["*"]]
    dom <- htmlParse(html_content, asText = TRUE, encoding = "UTF-8")
    
    # --- Extract infobox ---
    infobox <- parse_infobox(dom)
    
    # --- Extract article text ---
    article_text <- parse_article_text(dom)
    
    # --- Extract categories from API ---
    api_cats <- sapply(page_json$parse$categories, function(x) x[["*"]])
    categories <- paste(api_cats, collapse = "; ")
    
    # --- Build row ---
    row <- data.frame(
      title      = title,
      url        = paste0(base_url, "/wiki/", URLencode(str_replace_all(title, " ", "_"), reserved = TRUE)),
      text       = ifelse(nchar(article_text) > 0, article_text, NA_character_),
      categories = ifelse(nchar(categories) > 0, categories, NA_character_),
      stringsAsFactors = FALSE
    )
    
    # Map known infobox labels → standardized columns
    for (label in names(infobox_label_map)) {
      col_name <- infobox_label_map[[label]]
      if (!is.null(infobox[[label]])) {
        row[[col_name]] <- infobox[[label]]
      }
    }
    
    # Fill missing standard columns with NA
    for (col in infobox_columns) {
      if (is.null(row[[col]])) {
        row[[col]] <- NA_character_
      }
    }
    
    # Catch unexpected infobox fields → each gets its own column
    known_labels <- names(infobox_label_map)
    extra_labels <- setdiff(names(infobox), known_labels)
    if (length(extra_labels) > 0) {
      for (elabel in extra_labels) {
        # Sanitize label → column name
        ecol <- str_replace_all(tolower(elabel), "[^a-z0-9]+", "_")
        ecol <- str_replace_all(ecol, "^_+|_+$", "")
        row[[ecol]] <- infobox[[elabel]]
        cat(sprintf("  ℹ New infobox field: '%s' → col '%s'\n", elabel, ecol))
      }
    }
    
    results[[length(results) + 1]] <- row
    free(dom)
    
  }, error = function(e) {
    cat(sprintf("  ✖ Error: %s\n", e$message))
  })
  
  Sys.sleep(delay)
}

# =============================================================================
# STEP 5: Combine into a single dataframe and save
# =============================================================================
cat("── Step 3: Building final dataframe ──\n")

aesthetics_df <- bind_rows(results)

# Reorder columns: identity → connections → visuals → text → extras
col_priority <- c(
  "title", "url",
  # Connections
  "related_aesthetics", "subgenres", "preceded_by", "succeeded_by", "overlaps_with",
  # Identity
  "other_names", "decade_of_origin", "location_of_origin", "creators", "coined_by",
  # Visual / thematic
  "key_motifs", "key_colours", "key_values",
  # Platform / media
  "primary_platform", "related_media", "related_brands", "iconic_figures",
  # Content
  "categories", "text"
)
extra_cols <- setdiff(names(aesthetics_df), col_priority)
col_order  <- c(col_priority[col_priority %in% names(aesthetics_df)], extra_cols)
aesthetics_df <- aesthetics_df[, col_order]

cat(sprintf("Successfully scraped %d / %d aesthetics.\n", nrow(aesthetics_df), length(aesthetic_titles)))
cat(sprintf("Columns (%d): %s\n", ncol(aesthetics_df), paste(names(aesthetics_df), collapse = ", ")))

# --- Connection coverage stats ---
cat("\n── Connection field coverage ──\n")
connection_cols <- c("related_aesthetics", "subgenres", "preceded_by", "succeeded_by", "overlaps_with")
for (cc in connection_cols) {
  if (cc %in% names(aesthetics_df)) {
    n_filled <- sum(!is.na(aesthetics_df[[cc]]))
    cat(sprintf("  %-22s %d / %d filled (%3.0f%%)\n",
                paste0(cc, ":"), n_filled, nrow(aesthetics_df),
                100 * n_filled / nrow(aesthetics_df)))
  }
}

# --- List any extra columns that appeared from unexpected infobox fields ---
if (length(extra_cols) > 0) {
  cat(sprintf("\n── Extra columns from unexpected infobox fields (%d) ──\n", length(extra_cols)))
  for (ec in extra_cols) {
    n_filled <- sum(!is.na(aesthetics_df[[ec]]))
    cat(sprintf("  %-30s %d filled\n", paste0(ec, ":"), n_filled))
  }
}

# Save CSV
write_csv(aesthetics_df, output_path)
cat(sprintf("\n✔ Saved to %s\n", output_path))

# Save parquet
arrow::write_parquet(aesthetics_df, "./aesthetics_wiki_data.parquet")

# Save RDS (better for long text + special characters)
rds_path <- str_replace(output_path, "\\.csv$", ".rds")
saveRDS(aesthetics_df, rds_path)
cat(sprintf("✔ Saved to %s\n", rds_path))

# --- Quick summary ---
cat("\n── Summary ──\n")
cat(sprintf("Total aesthetics:  %d\n", nrow(aesthetics_df)))
cat(sprintf("Total columns:     %d\n", ncol(aesthetics_df)))
cat(sprintf("With article text: %d\n", sum(!is.na(aesthetics_df$text))))
cat(sprintf("Avg text length:   %.0f chars\n", mean(nchar(aesthetics_df$text), na.rm = TRUE)))